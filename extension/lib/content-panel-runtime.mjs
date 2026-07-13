import {
  callContentPanelApi,
  CONTENT_PANEL_API_OPERATIONS,
  CONTENT_PANEL_EXTENSION_PAGES,
  CONTENT_PANEL_PAGE_COMMANDS,
  safeContentPanelTab,
  verifyContentPanelSender,
} from './content-panel-api.mjs';

export const CONTENT_PANEL_EVENTS_PORT = 'HERMES_CONTENT_PANEL_EVENTS';

const ELEMENT_PICK_RUNTIME_MESSAGES = new Set([
  'HERMES_ELEMENT_PICKING',
  'HERMES_ELEMENT_PICK_RESULT',
  'HERMES_ELEMENT_PICK_CANCELLED',
]);

function createEventFacade() {
  const listeners = new Set();
  return {
    addListener(listener) {
      if (typeof listener === 'function') listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    hasListeners() {
      return listeners.size > 0;
    },
    emit(...args) {
      for (const listener of listeners) {
        try { listener(...args); } catch { /* one panel listener must not block the rest */ }
      }
    },
  };
}

function methodWithOptionalCallback(promise, callback) {
  if (typeof callback === 'function') {
    promise.then((value) => callback(value), () => callback(false));
  }
  return promise;
}

function pageCommandForPayload(payload = {}) {
  switch (payload?.type) {
    case 'HERMES_PING':
      return { command: CONTENT_PANEL_PAGE_COMMANDS.PING };
    case 'HERMES_GET_PAGE_CONTEXT':
      return { command: CONTENT_PANEL_PAGE_COMMANDS.GET_CONTEXT, depth: payload.options?.depth };
    case 'HERMES_START_ELEMENT_PICK':
      return { command: CONTENT_PANEL_PAGE_COMMANDS.START_ELEMENT_PICK };
    case 'HERMES_CANCEL_ELEMENT_PICK':
      return { command: CONTENT_PANEL_PAGE_COMMANDS.CANCEL_ELEMENT_PICK };
    default:
      throw new Error('This tab message is not available from the direct Safari panel.');
  }
}

function extensionDestinationForUrl(value, nativeChrome) {
  const url = String(value || '');
  if (url === nativeChrome.runtime.getURL('request-permissions.html')) {
    return CONTENT_PANEL_EXTENSION_PAGES.MICROPHONE_PERMISSION;
  }
  if (url === nativeChrome.runtime.getURL('voice-dictation.html')) {
    return CONTENT_PANEL_EXTENSION_PAGES.VOICE_DICTATION;
  }
  if (url.startsWith('chrome://settings/content/siteDetails')) {
    return CONTENT_PANEL_EXTENSION_PAGES.MICROPHONE_SETTINGS;
  }
  return '';
}

function dashboardBaseUrlFromTicketUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    const suffix = '/api/auth/ws-ticket';
    if (url.protocol !== 'https:' || !url.pathname.endsWith(suffix)) return '';
    url.pathname = url.pathname.slice(0, -suffix.length) || '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function createCompositeRuntimeOnMessage(nativeEvent, brokerEvent) {
  const wrappers = new Map();
  return {
    addListener(listener) {
      nativeEvent?.addListener?.(listener);
      if (wrappers.has(listener)) return;
      const wrapper = (message, sender) => listener(message, sender, () => {});
      wrappers.set(listener, wrapper);
      brokerEvent.addListener(wrapper);
    },
    removeListener(listener) {
      nativeEvent?.removeListener?.(listener);
      const wrapper = wrappers.get(listener);
      if (wrapper) brokerEvent.removeListener(wrapper);
      wrappers.delete(listener);
    },
    hasListener(listener) {
      return nativeEvent?.hasListener?.(listener) || wrappers.has(listener);
    },
  };
}

/**
 * Chrome API subset used by sidepanel.js when it runs in a Safari content
 * script. Storage and ordinary runtime calls stay native; privileged APIs are
 * represented by semantic, sender-validated background operations.
 */
export function createContentPanelChromeFacade({
  chromeApi: nativeChrome = globalThis.chrome,
  setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
} = {}) {
  const tabActivated = createEventFacade();
  const tabUpdated = createEventFacade();
  const tabRemoved = createEventFacade();
  const runtimeMessages = createEventFacade();
  let eventsPort = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;

  const handleEvent = (event) => {
    reconnectAttempt = 0;
    if (event?.type === 'tabs.activated') {
      tabActivated.emit({ tabId: event.tabId, windowId: event.windowId });
    } else if (event?.type === 'tabs.updated') {
      tabUpdated.emit(event.tabId, event.changeInfo || {}, event.tab || null);
    } else if (event?.type === 'tabs.removed') {
      tabRemoved.emit(event.tabId, { windowId: event.windowId, isWindowClosing: Boolean(event.isWindowClosing) });
    } else if (event?.type === 'runtime.message') {
      runtimeMessages.emit(event.message, { tab: event.senderTab || null });
    }
  };

  const scheduleEventReconnect = () => {
    if (reconnectTimer !== null || typeof setTimeoutImpl !== 'function') return;
    const delay = Math.min(5_000, 250 * (2 ** Math.min(reconnectAttempt, 4)));
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connectEventPort();
    }, delay);
  };

  function connectEventPort() {
    let port;
    try {
      port = nativeChrome.runtime.connect({ name: CONTENT_PANEL_EVENTS_PORT });
    } catch {
      scheduleEventReconnect();
      return;
    }
    eventsPort = port;
    port.onMessage.addListener(handleEvent);
    port.onDisconnect.addListener(() => {
      if (eventsPort !== port) return;
      eventsPort = null;
      scheduleEventReconnect();
    });
  }

  connectEventPort();

  const tabs = {
    async query(queryInfo = {}) {
      const snapshot = await callContentPanelApi(CONTENT_PANEL_API_OPERATIONS.TAB_SNAPSHOT, {}, { chromeApi: nativeChrome });
      let result = snapshot.tabs || [];
      if (queryInfo.active === true) result = result.filter((tab) => tab.active);
      if (Number.isFinite(Number(queryInfo.windowId))) {
        result = result.filter((tab) => Number(tab.windowId) === Number(queryInfo.windowId));
      }
      return result;
    },
    get(tabId) {
      return callContentPanelApi(CONTENT_PANEL_API_OPERATIONS.TAB_GET, { tabId }, { chromeApi: nativeChrome });
    },
    async create(createProperties = {}) {
      const destination = extensionDestinationForUrl(createProperties.url, nativeChrome);
      if (destination) {
        return callContentPanelApi(CONTENT_PANEL_API_OPERATIONS.OPEN_EXTENSION_PAGE, { destination }, { chromeApi: nativeChrome });
      }
      return callContentPanelApi(CONTENT_PANEL_API_OPERATIONS.OPEN_PAIRING_APPROVAL, {
        url: createProperties.url,
      }, { chromeApi: nativeChrome });
    },
    sendMessage(tabId, payload) {
      return callContentPanelApi(CONTENT_PANEL_API_OPERATIONS.PAGE_COMMAND, {
        tabId,
        ...pageCommandForPayload(payload),
      }, { chromeApi: nativeChrome });
    },
    onActivated: tabActivated,
    onUpdated: tabUpdated,
    onRemoved: tabRemoved,
  };

  const permissions = {
    contains(details, callback) {
      const valid = Array.isArray(details?.permissions)
        && details.permissions.length === 1
        && details.permissions[0] === 'audioCapture';
      const promise = valid
        ? callContentPanelApi(CONTENT_PANEL_API_OPERATIONS.AUDIO_PERMISSION, { action: 'contains' }, { chromeApi: nativeChrome })
        : Promise.resolve(false);
      return methodWithOptionalCallback(promise, callback);
    },
    request(details, callback) {
      const valid = Array.isArray(details?.permissions)
        && details.permissions.length === 1
        && details.permissions[0] === 'audioCapture';
      const promise = valid
        ? callContentPanelApi(CONTENT_PANEL_API_OPERATIONS.AUDIO_PERMISSION, { action: 'request' }, { chromeApi: nativeChrome })
        : Promise.resolve(false);
      return methodWithOptionalCallback(promise, callback);
    },
  };

  const scripting = {
    async executeScript(details = {}) {
      const tabId = Number(details.target?.tabId);
      if (Array.isArray(details.files) && details.files.length === 1 && details.files[0] === 'content.js') {
        const result = await tabs.sendMessage(tabId, { type: 'HERMES_PING' });
        return [{ result }];
      }
      if (typeof details.func === 'function' && details.func.name === 'collectPageContextFallback') {
        const result = await tabs.sendMessage(tabId, {
          type: 'HERMES_GET_PAGE_CONTEXT',
          options: details.args?.[0] || {},
        });
        return [{ result }];
      }
      if (typeof details.func === 'function' && details.func.name === 'mintTicketInPage') {
        const baseUrl = dashboardBaseUrlFromTicketUrl(details.args?.[0]);
        if (!baseUrl) throw new Error('Invalid dashboard ticket request.');
        const result = await callContentPanelApi(CONTENT_PANEL_API_OPERATIONS.DASHBOARD_MINT, {
          baseUrl,
          tabId,
        }, { chromeApi: nativeChrome });
        return [{ result }];
      }
      throw new Error('This script operation is not available from the direct Safari panel.');
    },
  };

  const runtime = new Proxy(nativeChrome.runtime, {
    get(target, property) {
      if (property === 'onMessage') return createCompositeRuntimeOnMessage(target.onMessage, runtimeMessages);
      if (property === 'sendMessage') {
        return async (message) => {
          if (message?.type === 'HERMES_GET_YOUTUBE_TRANSCRIPT') {
            return callContentPanelApi(CONTENT_PANEL_API_OPERATIONS.TRANSCRIPT_GET, {
              tabId: message.tabId,
            }, { chromeApi: nativeChrome });
          }
          return target.sendMessage(message);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return new Proxy(nativeChrome, {
    get(target, property) {
      if (property === 'tabs') return tabs;
      if (property === 'scripting') return scripting;
      if (property === 'permissions') return permissions;
      if (property === 'runtime') return runtime;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Installs sanitized tab events and element-picker echoes for direct panels. */
export function installContentPanelEventBroker({ chromeApi = globalThis.chrome } = {}) {
  const subscribers = new Set();

  chromeApi.runtime.onConnect.addListener((port) => {
    if (port?.name !== CONTENT_PANEL_EVENTS_PORT) return;
    const subscriber = { port, context: null };
    subscribers.add(subscriber);
    verifyContentPanelSender(port.sender, chromeApi)
      .then((context) => { subscriber.context = context; })
      .catch(() => {
        subscribers.delete(subscriber);
        try { port.disconnect(); } catch { /* already disconnected */ }
      });
    port.onDisconnect.addListener(() => subscribers.delete(subscriber));
  });

  const publish = (windowId, event) => {
    for (const subscriber of subscribers) {
      if (subscriber.context?.windowId !== Number(windowId)) continue;
      try { subscriber.port.postMessage(event); } catch { subscribers.delete(subscriber); }
    }
  };

  chromeApi.tabs?.onActivated?.addListener?.((activeInfo) => {
    publish(activeInfo.windowId, { type: 'tabs.activated', tabId: activeInfo.tabId, windowId: activeInfo.windowId });
  });
  chromeApi.tabs?.onUpdated?.addListener?.((tabId, changeInfo, tab) => {
    const safeChange = {};
    if (changeInfo?.status === 'loading' || changeInfo?.status === 'complete') safeChange.status = changeInfo.status;
    if (typeof changeInfo?.title === 'string') safeChange.title = changeInfo.title;
    if (typeof changeInfo?.url === 'string') safeChange.url = changeInfo.url;
    publish(tab?.windowId, {
      type: 'tabs.updated',
      tabId,
      changeInfo: safeChange,
      tab: safeContentPanelTab(tab),
    });
  });
  chromeApi.tabs?.onRemoved?.addListener?.((tabId, removeInfo) => {
    publish(removeInfo?.windowId, {
      type: 'tabs.removed',
      tabId,
      windowId: removeInfo?.windowId,
      isWindowClosing: Boolean(removeInfo?.isWindowClosing),
    });
  });

  return {
    echoRuntimeMessage(message, sender = {}) {
      if (!ELEMENT_PICK_RUNTIME_MESSAGES.has(message?.type)) return false;
      const windowId = Number(sender?.tab?.windowId);
      if (!Number.isFinite(windowId)) return false;
      publish(windowId, {
        type: 'runtime.message',
        message,
        senderTab: safeContentPanelTab(sender.tab),
      });
      return true;
    },
  };
}
