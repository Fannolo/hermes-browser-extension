/**
 * Shared contract for the injected (in-page) sidebar.
 *
 * Safari implements no sidebar API — neither chrome.sidePanel (Chromium-only)
 * nor sidebar_action (Firefox-only). The detached window in background.js works
 * everywhere but does not feel like a sidebar. The injected sidebar mounts
 * sidepanel.html in an iframe pinned to the right edge of the page instead.
 *
 * It cannot replace the detached window, only sit in front of it:
 *   - the content script only runs on http/https, so the Safari start page,
 *     PDFs, and about: pages have no sidebar to inject into;
 *   - a page's Content-Security-Policy `frame-src` can refuse our iframe.
 *
 * Both cases fall back to the detached window. Blocked frames are detected with
 * an explicit handshake (READY), not an iframe load event: a CSP-blocked frame
 * can still fire `load` for about:blank, so `load` cannot distinguish "mounted"
 * from "blocked". If READY does not arrive within READY_TIMEOUT_MS we treat the
 * mount as failed and fall back.
 *
 * content.js is a classic content script and cannot import this module, so it
 * mirrors these values literally. tests/injected-sidebar.test.mjs asserts the
 * two copies stay in sync.
 */

export const SIDEBAR_MESSAGES = Object.freeze({
  /** background -> content script: mount, or unmount if already mounted. */
  TOGGLE: 'HERMES_TOGGLE_SIDEBAR',
  /** iframe -> content script (window.postMessage): the panel really loaded. */
  READY: 'HERMES_SIDEBAR_READY',
  /** iframe -> content script (window.postMessage): user asked to close. */
  CLOSE: 'HERMES_SIDEBAR_CLOSE',
});

export const SIDEBAR_HOST_ID = 'hermes-browser-sidebar-host';

/** How long to wait for the READY handshake before declaring the frame blocked. */
export const READY_TIMEOUT_MS = 2500;

export const SIDEBAR_WIDTH = Object.freeze({
  DEFAULT: 420,
  MIN: 320,
  MAX: 900,
  STORAGE_KEY: 'hermesBrowserSidebarWidth',
});

export const SIDEBAR_PRESENTATION = Object.freeze({
  /** In-page iframe pinned to the right edge; falls back to WINDOW on failure. */
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
