/**
 * Shared contract for the injected (in-page) sidebar.
 *
 * Safari implements no sidebar API — neither chrome.sidePanel (Chromium-only)
 * nor sidebar_action (Firefox-only). The detached window in background.js works
 * everywhere but does not feel like a sidebar. The injected sidebar mounts a
 * persistent Shadow DOM host pinned to the right edge of the page instead. Its
 * open class uses the same off-canvas lifecycle as direct-DOM Safari sidebars.
 *
 * It cannot replace the detached-window fallback on every page:
 *   - the content script only runs on http/https, so the Safari start page,
 *     PDFs, and about: pages have no sidebar to inject into;
 *   - a browser can still refuse the extension document on a restricted page.
 *
 * The production Safari bundle renders directly in the ShadowRoot. READY is a
 * diagnostic contract for the unbundled extension-document fallback only.
 * Safari can wrap WindowProxy objects differently across its page and extension
 * worlds, so a missed handshake must never delete a visible sidebar or trigger
 * a detached window.
 *
 * content.js is a classic content script and cannot import this module, so it
 * mirrors these values literally. tests/injected-sidebar.test.mjs asserts the
 * two copies stay in sync.
 */

export const SIDEBAR_MESSAGES = Object.freeze({
  /** background -> content script: open, or slide closed if already open. */
  TOGGLE: 'HERMES_TOGGLE_SIDEBAR',
  /** background -> content script: mount if absent; a no-op if already mounted. */
  ENSURE: 'HERMES_ENSURE_SIDEBAR',
  /** fallback frame -> content script (window.postMessage): the panel loaded. */
  READY: 'HERMES_SIDEBAR_READY',
  /** fallback frame -> content script (window.postMessage): user asked to close. */
  CLOSE: 'HERMES_SIDEBAR_CLOSE',
  /** content script -> background: the user closed the sidebar from the page. */
  CLOSED: 'HERMES_SIDEBAR_CLOSED',
});

/**
 * Tabs whose sidebar is open, so it can be restored after a navigation.
 *
 * An injected sidebar lives in the page, so navigating destroys it — the usual
 * complaint about this technique, and what makes it feel like a hack rather than
 * a sidebar. Remembering which tabs had it open lets the background script
 * re-mount it once the new document is ready. Stored rather than kept in memory
 * because the MV3 service worker is evicted freely.
 */
export const SIDEBAR_OPEN_TABS_KEY = 'hermesBrowserSidebarOpenTabs';

export function normalizeOpenTabIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

export const SIDEBAR_HOST_ID = 'hermes-browser-sidebar-host';

/** How long to wait before logging a missing READY diagnostic. */
export const READY_TIMEOUT_MS = 2500;

export const SIDEBAR_WIDTH = Object.freeze({
  DEFAULT: 420,
  MIN: 320,
  MAX: 900,
  STORAGE_KEY: 'hermesBrowserSidebarWidth',
});

export const SIDEBAR_PRESENTATION = Object.freeze({
  /** Persistent in-page Shadow host pinned to the right edge. */
  INJECTED: 'injected',
  /** Always use the detached narrow window. */
  WINDOW: 'window',
});

export const DEFAULT_SIDEBAR_PRESENTATION = SIDEBAR_PRESENTATION.INJECTED;

export function normalizeSidebarPresentation(value = DEFAULT_SIDEBAR_PRESENTATION) {
  return value === SIDEBAR_PRESENTATION.WINDOW
    ? SIDEBAR_PRESENTATION.WINDOW
    : SIDEBAR_PRESENTATION.INJECTED;
}

export function clampSidebarWidth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return SIDEBAR_WIDTH.DEFAULT;
  return Math.min(SIDEBAR_WIDTH.MAX, Math.max(SIDEBAR_WIDTH.MIN, Math.round(numeric)));
}

/**
 * The injected sidebar is only possible where the content script runs.
 * Everything else (Safari start page, PDFs, about:, other extensions) must
 * fall back to the detached window.
 */
export function canInjectSidebar(url = '') {
  return /^https?:\/\//i.test(String(url || ''));
}
