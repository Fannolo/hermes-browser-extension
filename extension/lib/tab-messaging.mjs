import { isSafari } from './browser-runtime.mjs';

export const TAB_MESSAGE_RELAY = 'HERMES_RELAY_TAB_MESSAGE';

export const RELAYABLE_TAB_MESSAGE_TYPES = Object.freeze(new Set([
  'HERMES_PING',
  'HERMES_GET_PAGE_CONTEXT',
  'HERMES_START_ELEMENT_PICK',
  'HERMES_CANCEL_ELEMENT_PICK',
]));

export function isEmbeddedSafariPanel({
  safari = isSafari(),
  parentWindow = globalThis.parent,
  currentWindow = globalThis,
} = {}) {
  return Boolean(safari && parentWindow && parentWindow !== currentWindow);
}

export function canRelayTabMessage(tabId, payload) {
  const cleanTabId = Number(tabId);
  return Number.isFinite(cleanTabId)
    && cleanTabId > 0
    && RELAYABLE_TAB_MESSAGE_TYPES.has(payload?.type);
}

/**
 * Safari skips some same-tab messages sent by an extension page living inside
 * that tab. Route those messages through the background worker, which is not
 * subject to the extension-frame/content-script messaging bug.
 */
export async function sendTabMessage(tabId, payload, {
  chromeApi = globalThis.chrome,
  embeddedSafari = isEmbeddedSafariPanel(),
} = {}) {
  if (!embeddedSafari) return chromeApi.tabs.sendMessage(tabId, payload);

  const relayed = await chromeApi.runtime.sendMessage({
    type: TAB_MESSAGE_RELAY,
    tabId,
    payload,
  });
  if (!relayed?.ok) {
    throw new Error(relayed?.error || 'Safari could not reach the page content script.');
  }
  return relayed.response;
}
