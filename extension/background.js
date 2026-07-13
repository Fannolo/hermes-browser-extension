import {
  buildSidePanelPath,
  DEFAULT_PANEL_RESIDENCY_MODE,
  normalizePanelResidencyMode,
  PANEL_RESIDENCY_MODES,
} from './lib/panel-residency.mjs';
import {
  BROWSER_IDS,
  detectBrowserId,
  openNativeSidebar,
  setActionClickPanelBehavior as setPanelBehaviorForBrowser,
} from './lib/browser-runtime.mjs';
import {
  canInjectSidebar,
  DEFAULT_SIDEBAR_PRESENTATION,
  normalizeOpenTabIds,
  normalizeSidebarPresentation,
  READY_TIMEOUT_MS as SIDEBAR_READY_TIMEOUT_MS,
  SIDEBAR_MESSAGES,
  SIDEBAR_OPEN_TABS_KEY,
  SIDEBAR_PRESENTATION,
} from './lib/injected-sidebar.mjs';
import {
  canRelayTabMessage,
  TAB_MESSAGE_RELAY,
} from './lib/tab-messaging.mjs';

// The content script acknowledges mounts synchronously. Keep a defensive upper
// bound for missing/stale content scripts so toolbar clicks never hang forever.
const SIDEBAR_MOUNT_TIMEOUT_MS = SIDEBAR_READY_TIMEOUT_MS + 1500;
import {
  normalizeTranscriptPayload,
  parseTimedTextXml,
  parseYoutubeJson3,
  providerUrlForVideo,
} from './lib/transcript.mjs';

let cachedPanelResidencyMode = DEFAULT_PANEL_RESIDENCY_MODE;

function defaultSidePanelPath() {
  return chrome.runtime.getManifest().side_panel?.default_path || 'sidepanel.html';
}

function panelResidencyModeFromStorage(stored = {}) {
  return normalizePanelResidencyMode(
    stored?.hermesBrowserSettings?.panelResidencyMode
      || stored?.panelResidencyMode
      || DEFAULT_PANEL_RESIDENCY_MODE,
  );
}

async function refreshPanelResidencyModeFromStorage() {
  try {
    const stored = await chrome.storage.local.get(['hermesBrowserSettings', 'panelResidencyMode']);
    cachedPanelResidencyMode = panelResidencyModeFromStorage(stored);
  } catch (error) {
    console.warn('[Hermes Browser] Could not read panel residency setting:', error);
    cachedPanelResidencyMode = DEFAULT_PANEL_RESIDENCY_MODE;
  }
  return cachedPanelResidencyMode;
}

async function setActionClickSidePanelBehavior() {
  await setPanelBehaviorForBrowser();
}

async function activeBrowserTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = Number(tab?.id);
    return Number.isFinite(tabId) && tabId > 0 ? tabId : null;
  } catch {
    return null;
  }
}

async function applyPanelResidencyMode(mode = cachedPanelResidencyMode, { tabId = null } = {}) {
  const panelResidencyMode = normalizePanelResidencyMode(mode);
  const defaultPanelPath = defaultSidePanelPath();
  const cleanTabId = Number(tabId);
  const useTabAttached = panelResidencyMode === PANEL_RESIDENCY_MODES.TAB_ATTACHED && Number.isFinite(cleanTabId) && cleanTabId > 0;

  await setActionClickSidePanelBehavior();
  if (!chrome.sidePanel?.setOptions) return;

  if (panelResidencyMode === PANEL_RESIDENCY_MODES.TAB_ATTACHED) {
    await chrome.sidePanel.setOptions({ enabled: false });
    if (useTabAttached) {
      await chrome.sidePanel.setOptions({
        tabId: cleanTabId,
        path: buildSidePanelPath({
          mode: panelResidencyMode,
          tabId: cleanTabId,
          defaultPath: defaultPanelPath,
        }),
        enabled: true,
      });
    }
    return;
  }

  await chrome.sidePanel.setOptions({
    path: buildSidePanelPath({
      mode: panelResidencyMode,
      defaultPath: defaultPanelPath,
    }),
    enabled: true,
  });
}

async function configureSidePanel() {
  try {
    const panelResidencyMode = await refreshPanelResidencyModeFromStorage();
    const tabId = await activeBrowserTabId();
    // No popup for any browser — background.js handles the click.
    await chrome.action.setPopup({ popup: '' });
    await applyPanelResidencyMode(panelResidencyMode, { tabId });
  } catch (error) {
    console.warn('[Hermes Browser] Unable to set side panel behavior:', error);
  }
}

function reapplyPanelResidencyForTab(tabId) {
  applyPanelResidencyMode(cachedPanelResidencyMode, { tabId })
    .catch((error) => console.warn('[Hermes Browser] Could not apply panel residency setting:', error));
}

async function injectedSidebarPreferred() {
  try {
    const stored = await chrome.storage.local.get(['hermesBrowserSettings', 'sidebarPresentation']);
    const value = stored?.hermesBrowserSettings?.sidebarPresentation
      ?? stored?.sidebarPresentation
      ?? DEFAULT_SIDEBAR_PRESENTATION;
    return normalizeSidebarPresentation(value) === SIDEBAR_PRESENTATION.INJECTED;
  } catch {
    return normalizeSidebarPresentation(DEFAULT_SIDEBAR_PRESENTATION) === SIDEBAR_PRESENTATION.INJECTED;
  }
}

/**
 * Ask the content script to mount (or unmount) the in-page sidebar.
 *
 * Returns false — meaning "fall back to the detached window" — when the tab has
 * no content script (Safari start page, PDF, about:, another extension), or when
 * a stale content script never answers. A mounted page sidebar acknowledges the
 * request immediately; READY is diagnostic and does not gate success.
 */
// --- Sidebar-open tracking ---------------------------------------------------
// An injected sidebar lives in the page, so navigating destroys it. Remember
// which tabs had it open and restore it once the new document is ready — without
// this the sidebar disappears on every link click, which is the standard
// complaint about this technique. Persisted, because the MV3 service worker is
// evicted freely and in-memory state would not survive.

async function openSidebarTabs() {
  try {
    const stored = await chrome.storage.local.get([SIDEBAR_OPEN_TABS_KEY]);
    return new Set(normalizeOpenTabIds(stored?.[SIDEBAR_OPEN_TABS_KEY]));
  } catch {
    return new Set();
  }
}

async function setSidebarOpenForTab(tabId, open) {
  const cleanTabId = Number(tabId);
  if (!Number.isFinite(cleanTabId) || cleanTabId <= 0) return;
  try {
    const tabs = await openSidebarTabs();
    if (open) tabs.add(cleanTabId);
    else tabs.delete(cleanTabId);
    await chrome.storage.local.set({ [SIDEBAR_OPEN_TABS_KEY]: Array.from(tabs) });
  } catch {
    /* best-effort: losing this only costs an auto-restore */
  }
}

async function sendSidebarToggle(tabId, panelPath, { ensure = false } = {}) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, {
      type: ensure ? SIDEBAR_MESSAGES.ENSURE : SIDEBAR_MESSAGES.TOGGLE,
      url: chrome.runtime.getURL(panelPath),
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), SIDEBAR_MOUNT_TIMEOUT_MS)),
  ]);
}

/** Restore the sidebar after a navigation, if this tab had it open. */
async function restoreSidebarAfterNavigation(tabId, tab) {
  if (detectBrowserId() !== BROWSER_IDS.SAFARI) return;
  if (!canInjectSidebar(tab?.url)) return;
  if (!await injectedSidebarPreferred()) return;

  const tabs = await openSidebarTabs();
  if (!tabs.has(Number(tabId))) return;

  const panelPath = buildSidePanelPath({
    mode: cachedPanelResidencyMode,
    tabId,
    defaultPath: defaultSidePanelPath(),
  });
  try {
    const response = await sendSidebarToggle(tabId, panelPath, { ensure: true });
    if (!response?.ok) {
      // The new page refuses the sidebar (CSP). Stop trying for this tab rather
      // than popping a window the user never asked for on every navigation.
      await setSidebarOpenForTab(tabId, false);
    }
  } catch {
    await setSidebarOpenForTab(tabId, false);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  restoreSidebarAfterNavigation(tabId, tab)
    .catch((error) => console.warn('[Hermes Browser] Could not restore the sidebar:', error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  setSidebarOpenForTab(tabId, false).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === SIDEBAR_MESSAGES.CLOSED) {
    setSidebarOpenForTab(sender?.tab?.id, false).catch(() => {});
    return false;
  }
  if (message?.type === TAB_MESSAGE_RELAY) {
    if (!canRelayTabMessage(message.tabId, message.payload)) {
      sendResponse({ ok: false, error: 'Invalid tab-message relay request.' });
      return false;
    }
    chrome.tabs.sendMessage(Number(message.tabId), message.payload).then(
      (response) => sendResponse({ ok: true, response }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
    );
    return true;
  }
  return false;
});

async function tryInjectedSidebar(tab, panelPath) {
  const tabId = Number(tab?.id);
  if (!Number.isFinite(tabId) || tabId <= 0) return false;
  if (!canInjectSidebar(tab?.url)) {
    console.info('[Hermes Browser] Injected sidebar unavailable on this page; using a window.', tab?.url);
    return false;
  }

  try {
    const response = await sendSidebarToggle(tabId, panelPath);
    if (response?.ok) {
      // `mounted: false` means the user toggled it closed — remember that, or we
      // would helpfully resurrect it on their next navigation.
      await setSidebarOpenForTab(tabId, response.mounted !== false);
      return true;
    }
    if (response) return false;
    console.warn('[Hermes Browser] Sidebar mount timed out; using a window instead.');
    return false;
  } catch (error) {
    // The manifest content script is the only safe sidebar host on Safari.
    // Programmatic injection can reload the tab, and an async response-channel
    // failure can happen after the sidebar has already started mounting. Never
    // turn either case into an unexpected page reload.
    console.info(
      '[Hermes Browser] Static content script unavailable; using a window without reloading the page.',
      error?.message || error,
    );
    return false;
  }
}

async function openHermesPanel(tab) {
  await refreshPanelResidencyModeFromStorage();
  const panelResidencyMode = cachedPanelResidencyMode;
  const tabId = Number(tab?.id);
  const useTabAttached = panelResidencyMode === PANEL_RESIDENCY_MODES.TAB_ATTACHED && Number.isFinite(tabId) && tabId > 0;
  const defaultPanelPath = defaultSidePanelPath();
  const panelPath = buildSidePanelPath({
    mode: panelResidencyMode,
    tabId: useTabAttached ? tabId : null,
    defaultPath: defaultPanelPath,
  });

  // Safari has no sidebar API at all, so prefer the in-page injected sidebar and
  // fall back to the detached window when it cannot mount (non-web page, or the
  // page's CSP refuses our iframe).
  if (detectBrowserId() === BROWSER_IDS.SAFARI && await injectedSidebarPreferred()) {
    if (await tryInjectedSidebar(tab, panelPath)) return;
  }

  // Try Opera/Firefox native sidebar first.
  const opened = await openNativeSidebar({ windowId: tab?.windowId ?? null });
  if (opened) return;

  // Chrome/Edge/Comet sidePanel API
  const sidePanelCanOpen = Boolean(chrome.sidePanel?.open);
  const browserId = detectBrowserId();

  try {
    if (sidePanelCanOpen) {
      await applyPanelResidencyMode(panelResidencyMode, { tabId: useTabAttached ? tabId : null });
      if (useTabAttached) {
        try {
          await chrome.sidePanel.open({ tabId });
          return;
        } catch (tabOpenError) {
          if (!tab?.windowId) throw tabOpenError;
          const { windowId } = tab;
          console.warn('[Hermes Browser] Tab side panel open failed, retrying window side panel:', tabOpenError);
          await chrome.sidePanel.open({ windowId });
          return;
        }
      }
      if (tab?.windowId) {
        const { windowId } = tab;
        await chrome.sidePanel.open({ windowId });
        return;
      }
    }
  } catch (error) {
    console.warn('[Hermes Browser] Side panel open failed:', error);
  }

  // Opera/Firefox/Safari: open as a narrow popup window that acts like a
  // sidebar panel. None of these expose a usable MV3 side-panel API
  // (Safari supports neither chrome.sidePanel nor sidebar_action), so we use
  // windows.create with type: popup, a narrow width, and leftmost position.
  // A detached window — not an action popover — is deliberate: the panel must
  // survive clicks on the page for the element-picker flow.
  if (browserId === 'opera' || browserId === 'firefox' || browserId === 'safari') {
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL(panelPath),
        type: 'popup',
        width: 420,
        height: 800,
        left: 0,
        top: 0,
      });
      return;
    } catch (popupError) {
      console.warn('[Hermes Browser] Popup window creation failed:', popupError);
    }
  }

  // Last resort: open as extension tab
  await chrome.tabs.create({ url: chrome.runtime.getURL(panelPath) });
}

function timeoutSignal(ms = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timeout) };
}

async function fetchUserConfiguredTranscript(videoId, provider) {
  const url = providerUrlForVideo(provider, videoId);
  if (!url) return { ok: false, reason: 'custom_provider_not_configured', source: 'custom' };
  const { controller, done } = timeoutSignal();
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json, text/plain;q=0.9' } });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `custom_provider_${response.status}`, source: 'custom' };
    try {
      return normalizeTranscriptPayload(JSON.parse(text), 'custom');
    } catch {
      return normalizeTranscriptPayload({ text }, 'custom');
    }
  } finally {
    done();
  }
}

async function fetchDefaultTimedTextTranscript(videoId) {
  const attempts = [
    `https://video.google.com/timedtext?fmt=json3&lang=en&v=${encodeURIComponent(videoId)}`,
    `https://video.google.com/timedtext?fmt=json3&lang=en&kind=asr&v=${encodeURIComponent(videoId)}`,
    `https://video.google.com/timedtext?lang=en&v=${encodeURIComponent(videoId)}`,
    `https://video.google.com/timedtext?lang=en&kind=asr&v=${encodeURIComponent(videoId)}`,
  ];
  for (const url of attempts) {
    const { controller, done } = timeoutSignal();
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) continue;
      const text = await response.text();
      if (!text.trim()) continue;
      let segments = [];
      if (url.includes('fmt=json3')) {
        try {
          segments = parseYoutubeJson3(JSON.parse(text));
        } catch {
          segments = [];
        }
      } else {
        segments = parseTimedTextXml(text);
      }
      if (segments.length) {
        return normalizeTranscriptPayload({ segments, language: 'en' }, 'default-timedtext');
      }
    } catch (_error) {
      // Try next shape.
    } finally {
      done();
    }
  }
  return { ok: false, reason: 'default_timedtext_unavailable', source: 'default-timedtext' };
}

async function fetchDomTranscript(tabId) {
  if (!tabId) return { ok: false, reason: 'no_active_tab', source: 'page-dom' };
  try {
    return normalizeTranscriptPayload(
      await chrome.tabs.sendMessage(tabId, { type: 'HERMES_GET_YOUTUBE_TRANSCRIPT_DOM' }),
      'page-dom',
    );
  } catch (error) {
    return { ok: false, reason: error?.message || String(error), source: 'page-dom' };
  }
}

async function getYoutubeTranscript({ videoId, tabId, provider = 'default' } = {}) {
  const cleanVideoId = String(videoId || '').trim();
  const mode = String(provider || 'default').trim();
  if (!cleanVideoId) return { ok: false, reason: 'missing_video_id' };
  if (mode.toLowerCase() === 'off') return { ok: false, reason: 'transcripts_disabled' };

  const attempts = [];
  if (/^https?:\/\//i.test(mode)) attempts.push(() => fetchUserConfiguredTranscript(cleanVideoId, mode));
  attempts.push(() => fetchDefaultTimedTextTranscript(cleanVideoId));
  attempts.push(() => fetchDomTranscript(tabId));

  const failures = [];
  for (const attempt of attempts) {
    const result = await attempt();
    if (result?.ok && (result.text || result.segments?.length)) return { ...result, videoId: cleanVideoId };
    failures.push({ source: result?.source || 'unknown', reason: result?.reason || 'unavailable' });
  }
  return { ok: false, videoId: cleanVideoId, reason: failures.map((item) => `${item.source}:${item.reason}`).join('; ') || 'transcript_unavailable' };
}

chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);
chrome.action.onClicked.addListener(openHermesPanel);
chrome.tabs?.onActivated?.addListener?.(({ tabId }) => reapplyPanelResidencyForTab(tabId));
chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== 'local') return;
  let changed = false;
  if (changes.hermesBrowserSettings?.newValue?.panelResidencyMode) {
    cachedPanelResidencyMode = normalizePanelResidencyMode(changes.hermesBrowserSettings.newValue.panelResidencyMode);
    changed = true;
  } else if (changes.panelResidencyMode?.newValue) {
    cachedPanelResidencyMode = normalizePanelResidencyMode(changes.panelResidencyMode.newValue);
    changed = true;
  }
  if (changed) {
    activeBrowserTabId()
      .then((tabId) => reapplyPanelResidencyForTab(tabId));
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'HERMES_GET_YOUTUBE_TRANSCRIPT') return false;
  getYoutubeTranscript(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, reason: error?.message || String(error) }));
  return true;
});
