/**
 * DOM boundary shared by the extension page and Safari's injected Shadow DOM.
 *
 * sidepanel.js intentionally keeps using a document-shaped object. In ordinary
 * Chrome/Firefox panels this resolves to the real extension document. The
 * Safari content bundle configures a scoped mount before loading sidepanel.js,
 * so selectors and document-level events stay inside Hermes' ShadowRoot.
 */

import { createContentPanelChromeFacade } from './content-panel-runtime.mjs';
import {
  createContentPanelFetch,
  createContentPanelWebSocketClass,
} from './content-panel-transport.mjs';

export const PANEL_MOUNT_GLOBAL = '__HERMES_BROWSER_PANEL_MOUNT__';

export function resolvePanelMount(globalObject = globalThis) {
  const mount = globalObject?.[PANEL_MOUNT_GLOBAL];
  if (!mount?.root || !mount?.documentElement || !mount?.body) return null;
  return mount;
}

export function createPanelDocument(nativeDocument, mount = null) {
  if (!mount) return nativeDocument;

  const { root, documentElement, body } = mount;
  let panelTitle = 'Hermes Browser Extension';

  return {
    querySelector: root.querySelector.bind(root),
    querySelectorAll: root.querySelectorAll.bind(root),
    getElementById: root.getElementById
      ? root.getElementById.bind(root)
      : (id) => root.querySelector(`[id="${String(id).replace(/"/g, '\\"')}"]`),
    createElement: nativeDocument.createElement.bind(nativeDocument),
    addEventListener: root.addEventListener.bind(root),
    removeEventListener: root.removeEventListener.bind(root),
    documentElement,
    body,
    get title() {
      return panelTitle;
    },
    set title(value) {
      panelTitle = String(value || '');
    },
  };
}

export function resolvePanelDocument(globalObject = globalThis) {
  const nativeDocument = globalObject?.document;
  return createPanelDocument(nativeDocument, resolvePanelMount(globalObject));
}

export function resolvePanelRuntime(globalObject = globalThis) {
  const mount = resolvePanelMount(globalObject);
  const nativeChrome = globalObject?.chrome;
  const directBrokerAvailable = Boolean(mount && nativeChrome?.runtime?.connect);
  return {
    locationSearch: mount?.locationSearch ?? globalObject?.location?.search ?? '',
    sessionStorage: mount?.sessionStorage ?? globalObject?.sessionStorage ?? null,
    chrome: directBrokerAvailable
      ? createContentPanelChromeFacade({ chromeApi: nativeChrome })
      : nativeChrome,
    fetch: directBrokerAvailable
      ? createContentPanelFetch({ chromeApi: nativeChrome })
      : globalObject?.fetch?.bind?.(globalObject),
    WebSocket: directBrokerAvailable
      ? createContentPanelWebSocketClass({ chromeApi: nativeChrome })
      : globalObject?.WebSocket,
    direct: Boolean(mount),
  };
}

export function isDirectPanel(globalObject = globalThis) {
  return Boolean(resolvePanelMount(globalObject));
}
