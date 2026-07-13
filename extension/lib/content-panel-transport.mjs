import { DEFAULT_AGENT_PORTS } from './agent-discovery.mjs';
import { verifyContentPanelSender } from './content-panel-api.mjs';
import { WS_METHODS } from './gateway-ws.mjs';
import { normalizeExternalModelSourceList } from './model-discovery.mjs';

export const CONTENT_PANEL_HTTP_PORT = 'HERMES_CONTENT_PANEL_HTTP';
export const CONTENT_PANEL_WEBSOCKET_PORT = 'HERMES_CONTENT_PANEL_WEBSOCKET';

const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024 * 1024;
const MAX_WEBSOCKET_FRAME_BYTES = 2 * 1024 * 1024;
const ALLOWED_GATEWAY_METHODS = new Set(['GET', 'POST', 'PATCH']);
const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'authorization',
  'content-type',
  'x-hermes-profile',
  'x-hermes-session-id',
  'x-hermes-session-key',
  'x-hermes-session-token',
]);
const SENSITIVE_GATEWAY_HEADERS = new Set([
  'authorization',
  'x-hermes-profile',
  'x-hermes-session-id',
  'x-hermes-session-key',
]);
const GITHUB_UPDATE_PATHS = new Set([
  '/abundantbeing/hermes-browser-extension/main/package.json',
]);
const GITHUB_API_PATHS = new Set([
  '/repos/abundantbeing/hermes-browser-extension/commits/main',
]);
const GITHUB_COMPARE_PREFIX = '/repos/abundantbeing/hermes-browser-extension/compare/';

function cleanSettings(stored = {}) {
  return stored?.hermesBrowserSettings && typeof stored.hermesBrowserSettings === 'object'
    ? stored.hermesBrowserSettings
    : {};
}

async function transportSettings(chromeApi) {
  try {
    return cleanSettings(await chromeApi.storage?.local?.get?.(['hermesBrowserSettings']));
  } catch {
    return {};
  }
}

function parseHttpUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function normalizedBaseUrl(value = '') {
  const url = parseHttpUrl(value);
  if (!url) return null;
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

function pathWithinBase(url, base) {
  if (!url || !base || url.origin !== base.origin) return false;
  const prefix = base.pathname === '/' ? '' : base.pathname;
  return !prefix || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

function extensionResourceKind(url, runtimeGetUrl) {
  if (typeof runtimeGetUrl !== 'function') return '';
  for (const path of ['build-info.json', 'extension/build-info.json']) {
    try {
      const allowed = new URL(runtimeGetUrl(path));
      if (url.protocol === allowed.protocol && url.host === allowed.host && url.pathname === allowed.pathname) {
        return 'extension-resource';
      }
    } catch {
      // A browser can omit generated build metadata in source-loaded builds.
    }
  }
  return '';
}

function agentOrigins(settings = {}) {
  const scheme = settings.agentDiscoveryScheme === 'https' ? 'https' : 'http';
  const host = String(settings.agentDiscoveryHost || '127.0.0.1').trim();
  if (!host || /[/?#@]/.test(host.replace(/^\[[^\]]+\]$/, ''))) return new Set();
  const ports = Array.isArray(settings.agentPorts) && settings.agentPorts.length
    ? settings.agentPorts
    : DEFAULT_AGENT_PORTS;
  const origins = new Set();
  for (const value of ports.slice(0, 32)) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    try {
      origins.add(new URL(`${scheme}://${host}:${port}`).origin);
    } catch {
      // Ignore malformed user settings; the settings UI reports them separately.
    }
  }
  return origins;
}

/** Classifies a URL without granting arbitrary cross-origin fetch authority. */
export function classifyContentPanelTransportUrl(value, {
  settings = {},
  runtimeGetUrl = globalThis.chrome?.runtime?.getURL?.bind(globalThis.chrome.runtime),
} = {}) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;

  const extensionKind = extensionResourceKind(url, runtimeGetUrl);
  if (extensionKind) return { kind: extensionKind, url };
  if (!['http:', 'https:'].includes(url.protocol)) return null;

  const gateway = normalizedBaseUrl(settings.gatewayUrl || 'http://127.0.0.1:8642');
  if (pathWithinBase(url, gateway)) return { kind: 'gateway', url };

  if (agentOrigins(settings).has(url.origin) && ['/health', '/v1/models'].includes(url.pathname)) {
    return { kind: 'agent-discovery', url };
  }

  const customSources = new Set(normalizeExternalModelSourceList(settings.customModelSources || []));
  const customUrl = new URL(url.toString());
  customUrl.hash = '';
  if (customSources.has(customUrl.toString())) return { kind: 'custom-model-source', url };

  if (url.origin === 'http://127.0.0.1:9119' && ['/', '/api/model/options'].includes(url.pathname)) {
    return { kind: 'local-dashboard', url };
  }

  if (url.origin === 'https://raw.githubusercontent.com' && GITHUB_UPDATE_PATHS.has(url.pathname)) {
    return { kind: 'github-update', url };
  }
  if (
    url.origin === 'https://api.github.com'
    && (GITHUB_API_PATHS.has(url.pathname) || url.pathname.startsWith(GITHUB_COMPARE_PREFIX))
  ) {
    return { kind: 'github-update', url };
  }
  return null;
}

function serializedBodySize(body = '') {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(body).byteLength;
  return String(body).length;
}

function normalizedHeaders(value = {}) {
  try {
    return Array.from(new Headers(value).entries());
  } catch {
    return [];
  }
}

function sanitizeRequestHeaders(headers, kind) {
  const result = new Headers();
  for (const [rawName, rawValue] of normalizedHeaders(headers)) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(name)) continue;
    if (SENSITIVE_GATEWAY_HEADERS.has(name) && !['gateway', 'agent-discovery'].includes(kind)) continue;
    if (name === 'x-hermes-session-token' && !['gateway', 'local-dashboard'].includes(kind)) continue;
    const value = String(rawValue || '');
    if (!value || value.length > 8192 || /[\r\n]/.test(value)) continue;
    result.set(name, value);
  }
  return result;
}

export function prepareContentPanelHttpRequest(request = {}, {
  settings = {},
  runtimeGetUrl = globalThis.chrome?.runtime?.getURL?.bind(globalThis.chrome.runtime),
} = {}) {
  const target = classifyContentPanelTransportUrl(request.url, { settings, runtimeGetUrl });
  if (!target) throw new Error('The requested network destination is not allowed.');

  const method = String(request.method || 'GET').trim().toUpperCase();
  const allowedMethods = target.kind === 'gateway' ? ALLOWED_GATEWAY_METHODS : new Set(['GET']);
  if (!allowedMethods.has(method)) throw new Error('The requested HTTP method is not allowed for this destination.');

  const body = request.body == null ? undefined : String(request.body);
  if (body !== undefined && ['GET', 'HEAD'].includes(method)) throw new Error('GET requests cannot include a body.');
  if (body !== undefined && serializedBodySize(body) > MAX_REQUEST_BODY_BYTES) {
    throw new Error('The request body is too large.');
  }

  const credentials = request.credentials === 'include' && ['gateway', 'local-dashboard'].includes(target.kind)
    ? 'include'
    : 'omit';
  return {
    url: target.url.toString(),
    init: {
      method,
      headers: sanitizeRequestHeaders(request.headers, target.kind),
      body,
      credentials,
      cache: request.cache === 'no-store' ? 'no-store' : 'default',
      redirect: 'error',
    },
    kind: target.kind,
  };
}

function responseHeaders(response) {
  const headers = [];
  response.headers?.forEach?.((value, name) => {
    if (!['set-cookie', 'set-cookie2'].includes(String(name).toLowerCase())) headers.push([name, value]);
  });
  return headers;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value = '') {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function postPortMessage(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function portError(port, error) {
  postPortMessage(port, {
    type: 'error',
    error: String(error?.message || error || 'Network broker failed.'),
  });
}

function installHttpPort(port, { chromeApi, fetchImpl }) {
  let senderError = null;
  const senderVerification = verifyContentPanelSender(port.sender, chromeApi).catch((error) => {
    senderError = error;
    return null;
  });
  const controller = new AbortController();
  let cancelled = false;
  let started = false;

  const throwIfCancelled = () => {
    if (!cancelled && !controller.signal.aborted) return;
    const error = new Error('The network request was cancelled.');
    error.name = 'AbortError';
    throw error;
  };

  port.onMessage.addListener(async (message) => {
    if (message?.type === 'cancel') {
      cancelled = true;
      controller.abort();
      return;
    }
    if (message?.type !== 'request' || started) return;
    started = true;
    try {
      const senderContext = await senderVerification;
      throwIfCancelled();
      if (!senderContext) throw senderError || new Error('The network broker sender is invalid.');
      const settings = await transportSettings(chromeApi);
      throwIfCancelled();
      const prepared = prepareContentPanelHttpRequest(message.request, {
        settings,
        runtimeGetUrl: chromeApi.runtime?.getURL?.bind(chromeApi.runtime),
      });
      throwIfCancelled();
      const response = await fetchImpl(prepared.url, { ...prepared.init, signal: controller.signal });
      if (!postPortMessage(port, {
        type: 'head',
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response),
      })) return;

      if (!response.body) {
        postPortMessage(port, { type: 'end' });
        return;
      }
      const reader = response.body.getReader();
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        received += bytes.byteLength;
        if (received > MAX_RESPONSE_BODY_BYTES) throw new Error('The network response exceeded the broker limit.');
        if (!postPortMessage(port, { type: 'chunk', data: bytesToBase64(bytes) })) {
          controller.abort();
          return;
        }
      }
      postPortMessage(port, { type: 'end' });
    } catch (error) {
      portError(port, error?.name === 'AbortError' ? new Error('The network request was cancelled.') : error);
    }
  });
  port.onDisconnect.addListener(() => {
    cancelled = true;
    controller.abort();
  });
}

export function validateContentPanelWebSocketUrl(value, settings = {}) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash) return false;
  const trusted = normalizedBaseUrl(settings.trustedDashboardOrigin);
  const gateway = normalizedBaseUrl(settings.gatewayUrl);
  if (!trusted || !gateway || trusted.origin !== gateway.origin) return false;
  if (`https://${url.host}` !== trusted.origin) return false;
  const prefix = gateway.pathname === '/' ? '' : gateway.pathname;
  if (url.pathname !== `${prefix}/api/ws`) return false;
  if (Array.from(url.searchParams.keys()).some((key) => key !== 'ticket')) return false;
  const tickets = url.searchParams.getAll('ticket');
  return tickets.length === 1 && tickets[0].length > 0 && tickets[0].length <= 4096;
}

export function isAllowedGatewayRpcFrame(data) {
  if (typeof data !== 'string' || serializedBodySize(data) > MAX_WEBSOCKET_FRAME_BYTES) return false;
  try {
    const frame = JSON.parse(data);
    return frame?.jsonrpc === '2.0'
      && (typeof frame.id === 'number' || typeof frame.id === 'string')
      && Object.values(WS_METHODS).includes(frame.method)
      && frame.params
      && typeof frame.params === 'object'
      && !Array.isArray(frame.params);
  } catch {
    return false;
  }
}

function installWebSocketPort(port, { chromeApi, WebSocketImpl }) {
  let senderError = null;
  const senderVerification = verifyContentPanelSender(port.sender, chromeApi).catch((error) => {
    senderError = error;
    return null;
  });
  let socket = null;
  let connecting = false;

  port.onMessage.addListener(async (message) => {
    if (message?.type === 'connect' && !socket && !connecting) {
      connecting = true;
      try {
        const senderContext = await senderVerification;
        if (!senderContext) throw senderError || new Error('The WebSocket broker sender is invalid.');
        const settings = await transportSettings(chromeApi);
        if (!validateContentPanelWebSocketUrl(message.url, settings)) {
          throw new Error('The WebSocket destination is not the approved Hermes dashboard.');
        }
        socket = new WebSocketImpl(message.url);
        socket.addEventListener('open', () => postPortMessage(port, { type: 'open' }));
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string' || serializedBodySize(event.data) > MAX_WEBSOCKET_FRAME_BYTES) {
            socket?.close(1009, 'Unsupported frame');
            return;
          }
          postPortMessage(port, { type: 'message', data: event.data });
        });
        socket.addEventListener('error', () => postPortMessage(port, { type: 'socket-error' }));
        socket.addEventListener('close', (event) => postPortMessage(port, {
          type: 'close',
          code: Number(event?.code) || 1006,
          reason: String(event?.reason || '').slice(0, 240),
          wasClean: Boolean(event?.wasClean),
        }));
      } catch (error) {
        portError(port, error);
      }
      return;
    }
    if (message?.type === 'send') {
      if (!socket || socket.readyState !== 1 || !isAllowedGatewayRpcFrame(message.data)) {
        portError(port, new Error('The WebSocket frame is not an allowed Hermes RPC request.'));
        return;
      }
      socket.send(message.data);
      return;
    }
    if (message?.type === 'close') {
      const code = Number(message.code);
      const safeCode = Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000;
      socket?.close(safeCode, String(message.reason || '').slice(0, 120));
    }
  });
  port.onDisconnect.addListener(() => {
    try {
      socket?.close(1000, 'Content panel closed');
    } catch {
      // The browser may already have torn down the socket with the worker.
    }
  });
}

export function installContentPanelTransport({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  const listener = (port) => {
    if (port?.name === CONTENT_PANEL_HTTP_PORT && typeof fetchImpl === 'function') {
      installHttpPort(port, { chromeApi, fetchImpl });
    } else if (port?.name === CONTENT_PANEL_WEBSOCKET_PORT && typeof WebSocketImpl === 'function') {
      installWebSocketPort(port, { chromeApi, WebSocketImpl });
    }
  };
  chromeApi.runtime.onConnect.addListener(listener);
  return listener;
}

/** A fetch-compatible client backed by the background streaming port. */
export function createContentPanelFetch({ chromeApi = globalThis.chrome } = {}) {
  return async function contentPanelFetch(input, init = {}) {
    const request = new Request(input, init);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().text();
    const port = chromeApi.runtime.connect({ name: CONTENT_PANEL_HTTP_PORT });

    return new Promise((resolve, reject) => {
      let streamController;
      let responseStarted = false;
      let finished = false;
      const stream = new globalThis.ReadableStream({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          if (!finished) postPortMessage(port, { type: 'cancel' });
        },
      });
      const fail = (error) => {
        if (finished) return;
        finished = true;
        if (responseStarted) streamController.error(error);
        else reject(error);
        try { port.disconnect(); } catch { /* already disconnected */ }
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        streamController.close();
        try { port.disconnect(); } catch { /* already disconnected */ }
      };

      port.onMessage.addListener((message) => {
        if (message?.type === 'head') {
          if (responseStarted) return;
          responseStarted = true;
          const noBody = [204, 205, 304].includes(Number(message.status));
          resolve(new Response(noBody ? null : stream, {
            status: Number(message.status),
            statusText: String(message.statusText || ''),
            headers: message.headers || [],
          }));
          if (noBody) finish();
        } else if (message?.type === 'chunk' && !finished) {
          streamController.enqueue(base64ToBytes(message.data));
        } else if (message?.type === 'end') {
          finish();
        } else if (message?.type === 'error') {
          fail(new TypeError(message.error || 'The brokered fetch failed.'));
        }
      });
      port.onDisconnect.addListener(() => {
        if (!finished) fail(new TypeError(chromeApi.runtime?.lastError?.message || 'The network broker disconnected.'));
      });

      const abort = () => {
        postPortMessage(port, { type: 'cancel' });
        fail(request.signal.reason instanceof Error ? request.signal.reason : new DOMException('Aborted', 'AbortError'));
      };
      if (request.signal.aborted) {
        abort();
        return;
      }
      request.signal.addEventListener('abort', abort, { once: true });
      postPortMessage(port, {
        type: 'request',
        request: {
          url: request.url,
          method: request.method,
          headers: Array.from(request.headers.entries()),
          body,
          credentials: request.credentials,
          cache: request.cache,
        },
      });
    });
  };
}

export function createContentPanelWebSocketClass({ chromeApi = globalThis.chrome } = {}) {
  return class ContentPanelWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = String(url || '');
      this.readyState = ContentPanelWebSocket.CONNECTING;
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      this.listeners = new Map();
      this.port = chromeApi.runtime.connect({ name: CONTENT_PANEL_WEBSOCKET_PORT });
      this.port.onMessage.addListener((message) => this.#handle(message));
      this.port.onDisconnect.addListener(() => {
        if (this.readyState !== ContentPanelWebSocket.CLOSED) {
          this.readyState = ContentPanelWebSocket.CLOSED;
          this.#emit('close', { code: 1006, reason: 'WebSocket broker disconnected', wasClean: false });
        }
      });
      this.port.postMessage({ type: 'connect', url: this.url });
    }

    addEventListener(type, listener) {
      if (typeof listener !== 'function') return;
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    send(data) {
      if (this.readyState !== ContentPanelWebSocket.OPEN) throw new DOMException('WebSocket is not open', 'InvalidStateError');
      this.port.postMessage({ type: 'send', data: String(data) });
    }

    close(code = 1000, reason = '') {
      if (this.readyState >= ContentPanelWebSocket.CLOSING) return;
      this.readyState = ContentPanelWebSocket.CLOSING;
      this.port.postMessage({ type: 'close', code, reason });
    }

    #emit(type, detail = {}) {
      const event = { type, target: this, currentTarget: this, ...detail };
      for (const listener of this.listeners.get(type) || []) listener.call(this, event);
      const property = this[`on${type}`];
      if (typeof property === 'function') property.call(this, event);
    }

    #handle(message) {
      if (message?.type === 'open') {
        this.readyState = ContentPanelWebSocket.OPEN;
        this.#emit('open');
      } else if (message?.type === 'message') {
        this.#emit('message', { data: message.data });
      } else if (message?.type === 'socket-error' || message?.type === 'error') {
        this.#emit('error', { message: message.error || 'WebSocket broker error' });
      } else if (message?.type === 'close') {
        this.readyState = ContentPanelWebSocket.CLOSED;
        this.#emit('close', {
          code: Number(message.code) || 1006,
          reason: String(message.reason || ''),
          wasClean: Boolean(message.wasClean),
        });
        try { this.port.disconnect(); } catch { /* already disconnected */ }
      }
    }
  };
}
