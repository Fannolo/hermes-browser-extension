/**
 * Injected-sidebar handshake.
 *
 * When an unbundled development copy mounts sidepanel.html in a fallback frame
 * (see content.js), this tells the content script that the extension document
 * started. Production Safari builds render the panel directly in the ShadowRoot.
 * READY remains diagnostic only; missing it never removes a visible sidebar.
 *
 * This ships as its own file, loaded *before* sidepanel.js, on purpose. The
 * handshake means "the frame loaded and our code is running" — which is already
 * true here. Sending it from inside sidepanel.js would couple it to that
 * module's entire import graph and init path. Nothing here can throw.
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
      /* cross-origin parent: content.js will keep the mounted host open */
    }
  };
  ping();
  // Re-announce once the document is done, in case the content script's listener
  // was not yet attached when the frame started executing.
  globalThis.addEventListener('DOMContentLoaded', ping, { once: true });
  globalThis.addEventListener('load', ping, { once: true });
})();
