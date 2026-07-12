/**
 * Browser runtime detection and panel host abstraction for Hermes Browser Extension.
 *
 * Detects the active browser (Chrome/Edge/Comet, Opera, Firefox, Safari) and
 * provides a unified interface for opening/residency that prefers native
 * sidePanel/sidebarAction APIs and falls back to an extension tab.
 */

const BROWSER_IDS = Object.freeze({
  CHROMIUM: 'chromium',
  OPERA: 'opera',
  FIREFOX: 'firefox',
  SAFARI: 'safari',
  UNKNOWN: 'unknown',
});

/**
 * Safari serves extension pages from the safari-web-extension:// scheme. That is
 * an exact signal, unlike the UA string: every Chromium UA also contains the
 * token "Safari", and the MV3 service worker UA is not guaranteed to match the
 * page UA. Check the scheme before falling back to UA sniffing.
 */
function hasSafariExtensionScheme() {
  try {
    const url = globalThis.chrome?.runtime?.getURL?.('') || globalThis.browser?.runtime?.getURL?.('') || '';
    return url.startsWith('safari-web-extension://');
  } catch {
    return false;
  }
}

function detectBrowserId() {
  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
  if (hasSafariExtensionScheme()) return BROWSER_IDS.SAFARI;
  // Check UA first — more reliable than globalThis.opr which may not exist
  // in the MV3 service worker context even on Opera.
  if (/\bOPR\/|Opera\b/i.test(ua)) return BROWSER_IDS.OPERA;
  if (typeof globalThis !== 'undefined' && globalThis.opr?.sidebarAction) return BROWSER_IDS.OPERA;
  if (typeof globalThis !== 'undefined' && globalThis.browser?.sidebarAction) return BROWSER_IDS.FIREFOX;
  if (/\bFirefox\b/i.test(ua)) return BROWSER_IDS.FIREFOX;
  if (/\bSafari\b/i.test(ua) && !/\bChrome\b/i.test(ua)) return BROWSER_IDS.SAFARI;
  return BROWSER_IDS.CHROMIUM;
}

function isSafari() {
  return detectBrowserId() === BROWSER_IDS.SAFARI;
}

function getSidebarAction() {
  if (typeof globalThis === 'undefined') return null;
  // Opera exposes sidebarAction on chrome.sidebarAction or opr.sidebarAction
  return globalThis.opr?.sidebarAction || globalThis.browser?.sidebarAction || globalThis.chrome?.sidebarAction || null;
}

function hasChromeSidePanel() {
  return typeof globalThis !== 'undefined' && Boolean(globalThis.chrome?.sidePanel?.open);
}

function hasSidebarAction() {
  const sa = getSidebarAction();
  if (!sa) return false;
  // Must have at least one of the known open methods
  return typeof sa.open === 'function' || typeof sa.setOpenState === 'function';
}

/**
 * Open the browser's native sidebar/side panel for the current window.
 * Returns true if the native path handled the open; false if a fallback
 * (extension tab) should be used.
 *
 * Opera uses sidebarAction.setOpenState(true), not .open().
 * Firefox uses sidebarAction.open() (promise/callback based).
 */
async function openNativeSidebar({ windowId = null } = {}) {
  const sidebarAction = getSidebarAction();
  if (!sidebarAction) return false;

  try {
    // Opera: sidebarAction.setOpenState(true) — no .open() method
    if (typeof sidebarAction.setOpenState === 'function') {
      await new Promise((resolve) => {
        try {
          const result = sidebarAction.setOpenState(true);
          if (result && typeof result.then === 'function') {
            result.then(resolve, resolve);
          } else {
            resolve();
          }
        } catch {
          resolve(); // best-effort — sidebar may already be open
        }
      });
      return true;
    }

    // Firefox: sidebarAction.open() — promise or callback based
    if (typeof sidebarAction.open === 'function') {
      await new Promise((resolve, reject) => {
        try {
          const result = sidebarAction.open();
          if (result && typeof result.then === 'function') {
            result.then(resolve, reject);
          } else {
            resolve();
          }
        } catch (err) {
          // Some implementations require a callback
          try {
            const cbResult = sidebarAction.open(() => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve();
            });
            if (cbResult && typeof cbResult.then === 'function') {
              cbResult.then(resolve, reject);
            }
          } catch {
            resolve(); // best-effort
          }
        }
      });
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[Hermes Browser] Native sidebar open failed:', err);
    return false;
  }
}

/**
 * Set panel behavior — toolbar click opens panel.
 * Chrome uses chrome.sidePanel.setPanelBehavior.
 * Opera/Firefox sidebarAction does not have a direct equivalent; the
 * _execute_sidebar_action manifest command handles keyboard shortcut.
 */
async function setActionClickPanelBehavior() {
  const browserId = detectBrowserId();

  // Opera/Firefox sidebarAction: no setPanelBehavior equivalent —
  // the _execute_sidebar_action manifest command handles keyboard shortcut
  // and toolbar click opens the sidebar via the sidebar_action manifest key.
  // But Opera also supports chrome.sidePanel — if available, set it too
  // so both the sidebar and sidePanel paths work.
  if (browserId === BROWSER_IDS.OPERA || browserId === BROWSER_IDS.FIREFOX) {
    // Still set Chrome sidePanel behavior if Opera supports it (it often does)
    if (globalThis.chrome?.sidePanel?.setPanelBehavior) {
      try {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      } catch {
        // Opera may not fully support this — best-effort
      }
    }
    return;
  }

  // Chrome/Edge/Comet sidePanel
  if (!globalThis.chrome?.sidePanel?.setPanelBehavior) return;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

/**
 * Determine whether the extension should use native sidePanel (Chrome)
 * or native sidebarAction (Opera/Firefox) for panel residency.
 */
function nativePanelMode() {
  if (hasChromeSidePanel()) return 'chrome-sidePanel';
  if (hasSidebarAction()) return 'sidebarAction';
  // Safari has no sidebar API at all (neither chrome.sidePanel nor
  // sidebar_action), so it always lands on the detached-window path.
  if (detectBrowserId() === BROWSER_IDS.SAFARI) return 'extension-window';
  return 'extension-tab';
}

export {
  BROWSER_IDS,
  detectBrowserId,
  getSidebarAction,
  hasChromeSidePanel,
  hasSidebarAction,
  isSafari,
  openNativeSidebar,
  setActionClickPanelBehavior,
  nativePanelMode,
};
