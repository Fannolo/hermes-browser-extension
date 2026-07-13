import {
  isTrustedDashboardOrigin,
  mintWsTicket,
  originOf,
} from './dashboard-bridge.mjs';
import { extractYouTubeVideoId } from './transcript.mjs';

export const CONTENT_PANEL_API_MESSAGE = 'HERMES_CONTENT_PANEL_API';

export const CONTENT_PANEL_API_OPERATIONS = Object.freeze({
  TAB_SNAPSHOT: 'tabs.snapshot',
  TAB_GET: 'tabs.get',
  PAGE_COMMAND: 'page.command',
  OPEN_EXTENSION_PAGE: 'tabs.openExtensionPage',
  OPEN_PAIRING_APPROVAL: 'tabs.openPairingApproval',
  AUDIO_PERMISSION: 'permissions.audio',
  DASHBOARD_FIND: 'dashboard.find',
  DASHBOARD_MINT: 'dashboard.mint',
  TRANSCRIPT_GET: 'transcript.get',
});

export const CONTENT_PANEL_PAGE_COMMANDS = Object.freeze({
  PING: 'ping',
  GET_CONTEXT: 'context.get',
  START_ELEMENT_PICK: 'elementPick.start',
  CANCEL_ELEMENT_PICK: 'elementPick.cancel',
});

export const CONTENT_PANEL_EXTENSION_PAGES = Object.freeze({
  MICROPHONE_PERMISSION: 'microphone-permission',
  MICROPHONE_SETTINGS: 'microphone-settings',
  VOICE_DICTATION: 'voice-dictation',
});

const EXTENSION_PAGE_PATHS = Object.freeze({
  [CONTENT_PANEL_EXTENSION_PAGES.MICROPHONE_PERMISSION]: 'request-permissions.html',
  [CONTENT_PANEL_EXTENSION_PAGES.VOICE_DICTATION]: 'voice-dictation.html',
});

const CONTEXT_DEPTHS = new Set(['minimal', 'normal', 'full']);

class ContentPanelApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContentPanelApiError';
    this.code = code;
  }
}

function apiError(code, message) {
  return new ContentPanelApiError(code, message);
}

function errorResponse(error) {
  return {
    ok: false,
    code: String(error?.code || 'operation_failed'),
    error: String(error?.message || error || 'Content panel operation failed.'),
  };
}

function successResponse(value) {
  return { ok: true, value };
}

function cleanPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function isHttpPage(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function httpOrigin(url = '') {
  if (!isHttpPage(url)) return '';
  return new URL(url).origin;
}

export function safeContentPanelTab(tab = {}) {
  return {
    id: cleanPositiveInteger(tab.id),
    windowId: cleanPositiveInteger(tab.windowId),
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    status: ['loading', 'complete'].includes(tab.status) ? tab.status : '',
    title: String(tab.title || '(untitled)'),
    url: String(tab.url || tab.pendingUrl || ''),
    favIconUrl: String(tab.favIconUrl || ''),
  };
}

function normalizePageCommand(command, args = {}) {
  switch (command) {
    case CONTENT_PANEL_PAGE_COMMANDS.PING:
      return { type: 'HERMES_PING' };
    case CONTENT_PANEL_PAGE_COMMANDS.GET_CONTEXT: {
      const depth = CONTEXT_DEPTHS.has(args.depth) ? args.depth : 'normal';
      return { type: 'HERMES_GET_PAGE_CONTEXT', options: { depth } };
    }
    case CONTENT_PANEL_PAGE_COMMANDS.START_ELEMENT_PICK:
      return { type: 'HERMES_START_ELEMENT_PICK' };
    case CONTENT_PANEL_PAGE_COMMANDS.CANCEL_ELEMENT_PICK:
      return { type: 'HERMES_CANCEL_ELEMENT_PICK' };
    default:
      throw apiError('unknown_page_command', 'The requested page command is not allowed.');
  }
}

async function storageSettings(chromeApi) {
  try {
    const stored = await chromeApi.storage?.local?.get?.(['hermesBrowserSettings']);
    return stored?.hermesBrowserSettings && typeof stored.hermesBrowserSettings === 'object'
      ? stored.hermesBrowserSettings
      : {};
  } catch {
    return {};
  }
}

export async function verifyContentPanelSender(sender, chromeApi = globalThis.chrome) {
  const runtimeId = String(chromeApi.runtime?.id || '');
  if (runtimeId && sender?.id && sender.id !== runtimeId) {
    throw apiError('foreign_sender', 'The request did not come from this extension.');
  }
  if (sender?.frameId != null && Number(sender.frameId) !== 0) {
    throw apiError('subframe_sender', 'Content panel operations are only available to the top frame.');
  }

  const tabId = cleanPositiveInteger(sender?.tab?.id);
  const windowId = cleanPositiveInteger(sender?.tab?.windowId);
  if (!tabId || !windowId || !isHttpPage(sender?.tab?.url)) {
    throw apiError('invalid_sender_tab', 'Content panel operations require an http(s) host tab.');
  }

  let tab;
  try {
    tab = await chromeApi.tabs.get(tabId);
  } catch {
    throw apiError('sender_tab_closed', 'The content panel host tab is no longer open.');
  }
  if (
    cleanPositiveInteger(tab?.id) !== tabId
    || cleanPositiveInteger(tab?.windowId) !== windowId
    || !isHttpPage(tab?.url)
    || httpOrigin(tab.url) !== httpOrigin(sender.tab.url)
  ) {
    throw apiError('sender_tab_changed', 'The content panel host tab changed before the operation ran.');
  }

  return { tabId, windowId, tab };
}

async function verifiedTargetTab(tabId, senderContext, chromeApi) {
  const cleanTabId = cleanPositiveInteger(tabId);
  if (!cleanTabId) throw apiError('invalid_tab_id', 'A valid target tab is required.');

  let tab;
  try {
    tab = await chromeApi.tabs.get(cleanTabId);
  } catch {
    throw apiError('target_tab_closed', 'The target tab is no longer open.');
  }
  if (cleanPositiveInteger(tab?.windowId) !== senderContext.windowId) {
    throw apiError('cross_window_tab', 'The content panel cannot access a tab in another window.');
  }
  if (!isHttpPage(tab?.url)) {
    throw apiError('restricted_target_tab', 'The content panel can only access http(s) tabs.');
  }
  return tab;
}

function approvalUrlForGateway(url, gatewayUrl) {
  if (!isHttpPage(url) || !isHttpPage(gatewayUrl)) return '';
  const approval = new URL(url);
  const gateway = new URL(gatewayUrl);
  return approval.origin === gateway.origin ? approval.toString() : '';
}

function permissionCall(chromeApi, action) {
  const permissionsApi = chromeApi.permissions;
  const method = permissionsApi?.[action];
  // Safari grants microphone access per origin and exposes no audioCapture
  // extension permission, so an absent API is equivalent to no extra grant.
  if (typeof method !== 'function') return Promise.resolve(true);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const runtimeError = chromeApi.runtime?.lastError;
      if (runtimeError) reject(new Error(runtimeError.message || String(runtimeError)));
      else resolve(Boolean(value));
    };
    try {
      const pending = method.call(permissionsApi, { permissions: ['audioCapture'] }, finish);
      if (pending?.then) pending.then(finish, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function scopedDashboardTabsApi(chromeApi, senderContext, dashboardTabId) {
  return {
    async query() {
      const current = await chromeApi.tabs.get(dashboardTabId);
      if (
        cleanPositiveInteger(current?.windowId) !== senderContext.windowId
        || !current.active
        || !isHttpPage(current.url)
      ) return [];
      return [current];
    },
    async get(tabId) {
      if (cleanPositiveInteger(tabId) !== dashboardTabId) {
        throw apiError('dashboard_tab_mismatch', 'Dashboard Attach is bound to the selected dashboard tab.');
      }
      return chromeApi.tabs.get(dashboardTabId);
    },
  };
}

async function openExtensionPage(chromeApi, destination) {
  let url = '';
  if (destination === CONTENT_PANEL_EXTENSION_PAGES.MICROPHONE_SETTINGS) {
    const runtimeId = String(chromeApi.runtime?.id || '');
    if (!runtimeId) throw apiError('runtime_id_unavailable', 'The extension ID is unavailable.');
    url = `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${runtimeId}/`)}`;
  } else {
    const path = EXTENSION_PAGE_PATHS[destination];
    if (!path) throw apiError('unknown_extension_page', 'The requested extension page is not allowed.');
    url = chromeApi.runtime.getURL(path);
  }
  const opened = await chromeApi.tabs.create({ url, active: true });
  return { tabId: cleanPositiveInteger(opened?.id), url };
}

/**
 * Creates the background-side facade used by a Hermes panel running directly in
 * a Safari content script. No raw chrome.tabs or chrome.scripting operation is
 * exposed: each operation is allowlisted and rebound to the sender's host tab.
 */
export function createContentPanelApiHandler({
  chromeApi = globalThis.chrome,
  transcriptResolver = null,
  mintDashboardTicket = mintWsTicket,
} = {}) {
  return async function handleContentPanelApi(message, sender = {}) {
    if (message?.type !== CONTENT_PANEL_API_MESSAGE) {
      return errorResponse(apiError('invalid_message', 'Unknown content panel API message.'));
    }

    try {
      const senderContext = await verifyContentPanelSender(sender, chromeApi);
      const args = message.args && typeof message.args === 'object' ? message.args : {};

      switch (message.operation) {
        case CONTENT_PANEL_API_OPERATIONS.TAB_SNAPSHOT: {
          const tabs = (await chromeApi.tabs.query({ windowId: senderContext.windowId }))
            .filter((tab) => cleanPositiveInteger(tab?.windowId) === senderContext.windowId)
            .map(safeContentPanelTab);
          const activeTab = tabs.find((tab) => tab.active) || safeContentPanelTab(senderContext.tab);
          return successResponse({
            hostTab: safeContentPanelTab(senderContext.tab),
            activeTab,
            tabs,
          });
        }
        case CONTENT_PANEL_API_OPERATIONS.TAB_GET: {
          const tab = await verifiedTargetTab(args.tabId, senderContext, chromeApi);
          return successResponse(safeContentPanelTab(tab));
        }
        case CONTENT_PANEL_API_OPERATIONS.PAGE_COMMAND: {
          const tab = await verifiedTargetTab(args.tabId, senderContext, chromeApi);
          const payload = normalizePageCommand(args.command, args);
          const value = await chromeApi.tabs.sendMessage(tab.id, payload);
          return successResponse(value);
        }
        case CONTENT_PANEL_API_OPERATIONS.OPEN_EXTENSION_PAGE:
          return successResponse(await openExtensionPage(chromeApi, args.destination));
        case CONTENT_PANEL_API_OPERATIONS.OPEN_PAIRING_APPROVAL: {
          const settings = await storageSettings(chromeApi);
          const url = approvalUrlForGateway(args.url, settings.gatewayUrl);
          if (!url) {
            throw apiError('untrusted_approval_url', 'The pairing approval URL must use the configured gateway origin.');
          }
          const opened = await chromeApi.tabs.create({ url, active: true });
          return successResponse({ tabId: cleanPositiveInteger(opened?.id), url });
        }
        case CONTENT_PANEL_API_OPERATIONS.AUDIO_PERMISSION: {
          if (!['contains', 'request'].includes(args.action)) {
            throw apiError('unknown_permission_action', 'Only audio permission checks and requests are allowed.');
          }
          return successResponse(await permissionCall(chromeApi, args.action));
        }
        case CONTENT_PANEL_API_OPERATIONS.DASHBOARD_FIND: {
          const origin = originOf(args.baseUrl);
          if (!origin) return successResponse(null);
          const tabs = await chromeApi.tabs.query({ active: true, windowId: senderContext.windowId });
          const requestedTabId = cleanPositiveInteger(args.tabId);
          const tab = (tabs || []).find((candidate) => (
            cleanPositiveInteger(candidate?.windowId) === senderContext.windowId
            && (!requestedTabId || cleanPositiveInteger(candidate?.id) === requestedTabId)
            && candidate.active
            && candidate.status === 'complete'
            && !candidate.discarded
            && !candidate.pendingUrl
            && originOf(candidate.url) === origin
          ));
          return successResponse(tab ? safeContentPanelTab(tab) : null);
        }
        case CONTENT_PANEL_API_OPERATIONS.DASHBOARD_MINT: {
          const settings = await storageSettings(chromeApi);
          if (!isTrustedDashboardOrigin(args.baseUrl, settings.trustedDashboardOrigin)) {
            throw apiError('dashboard_origin_untrusted', 'The dashboard origin has not been approved.');
          }
          const dashboardTab = await verifiedTargetTab(args.tabId || senderContext.tabId, senderContext, chromeApi);
          const dashboardTabId = cleanPositiveInteger(dashboardTab.id);
          const result = await mintDashboardTicket({
            tabsApi: scopedDashboardTabsApi(chromeApi, senderContext, dashboardTabId),
            scriptingApi: chromeApi.scripting,
            baseUrl: args.baseUrl,
            tabId: dashboardTabId,
          });
          return successResponse(result);
        }
        case CONTENT_PANEL_API_OPERATIONS.TRANSCRIPT_GET: {
          if (typeof transcriptResolver !== 'function') {
            throw apiError('transcript_unavailable', 'Transcript retrieval is unavailable.');
          }
          const tab = await verifiedTargetTab(args.tabId, senderContext, chromeApi);
          const videoId = extractYouTubeVideoId(tab.url);
          if (!videoId) return successResponse(null);
          const settings = await storageSettings(chromeApi);
          const provider = String(settings.transcriptProvider || 'default').trim() || 'default';
          return successResponse(await transcriptResolver({ videoId, tabId: tab.id, provider }));
        }
        default:
          throw apiError('unknown_operation', 'The requested content panel operation is not allowed.');
      }
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export async function callContentPanelApi(operation, args = {}, { chromeApi = globalThis.chrome } = {}) {
  const response = await chromeApi.runtime.sendMessage({
    type: CONTENT_PANEL_API_MESSAGE,
    operation,
    args,
  });
  if (!response?.ok) {
    const error = new Error(response?.error || 'The Hermes content panel operation failed.');
    error.code = response?.code || 'operation_failed';
    throw error;
  }
  return response.value;
}
