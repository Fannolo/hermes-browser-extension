/**
 * Injected-sidebar handshake.
 *
 * When sidepanel.html is mounted in-page as a sidebar (see content.js), the
 * content script needs proof that the frame really loaded. It cannot use the
 * iframe's `load` event: a page whose CSP `frame-src` blocks us still fires
 * `load` for about:blank, so `load` cannot tell "blocked" from "mounted".
 *
 * This ships as its own file, loaded *before* sidepanel.js, on purpose. The
 * handshake means "the frame loaded and our code is running" — which is already
 * true here. Sending it from inside sidepanel.js would couple it to that
 * module's entire import graph and init path, so any error during startup would
 * suppress the ping, time out the mount, and silently demote the user to the
 * detached window. Nothing here can throw.
 *
 * Harmless outside the sidebar: in a tab, popup, or detached window there is no
 * parent frame, so this is a no-op.
 */
(() => {
  if (!globalThis.parent || globalThis.parent === globalThis) return;
  const ping = () => {
    try {
      globalThis.parent.postMessage({ type: 'HERMES_SIDEBAR_READY' }, '*');
    } catch {
      /* cross-origin parent: the mount will time out and fall back to a window */
    }
  };
  ping();
  // Re-announce once the document is done, in case the content script's listener
  // was not yet attached when the frame started executing.
  globalThis.addEventListener('DOMContentLoaded', ping, { once: true });
  globalThis.addEventListener('load', ping, { once: true });
})();
