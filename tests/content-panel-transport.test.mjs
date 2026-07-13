import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyContentPanelTransportUrl,
  installContentPanelTransport,
  isAllowedGatewayRpcFrame,
  prepareContentPanelHttpRequest,
  validateContentPanelWebSocketUrl,
} from '../extension/lib/content-panel-transport.mjs';

const settings = {
  gatewayUrl: 'http://127.0.0.1:8642/hermes',
  trustedDashboardOrigin: 'https://dashboard.example',
  agentDiscoveryHost: 'agent.internal',
  agentDiscoveryScheme: 'https',
  agentPorts: [8642, 8643],
  customModelSources: ['https://models.example/catalog'],
};

const runtimeGetUrl = (path) => `safari-web-extension://hermes/${path}`;

function eventChannel() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); },
  };
}

test('transport allowlist covers configured Hermes resources only', () => {
  assert.equal(classifyContentPanelTransportUrl('http://127.0.0.1:8642/hermes/health', { settings, runtimeGetUrl }).kind, 'gateway');
  assert.equal(classifyContentPanelTransportUrl('https://agent.internal:8643/health', { settings, runtimeGetUrl }).kind, 'agent-discovery');
  assert.equal(classifyContentPanelTransportUrl('https://agent.internal:8643/v1/models', { settings, runtimeGetUrl }).kind, 'agent-discovery');
  assert.equal(classifyContentPanelTransportUrl('https://models.example/catalog/v1/models', { settings, runtimeGetUrl }).kind, 'custom-model-source');
  assert.equal(classifyContentPanelTransportUrl('https://raw.githubusercontent.com/abundantbeing/hermes-browser-extension/main/package.json?t=1', { settings, runtimeGetUrl }).kind, 'github-update');
  assert.equal(classifyContentPanelTransportUrl('safari-web-extension://hermes/build-info.json?t=1', { settings, runtimeGetUrl }).kind, 'extension-resource');

  assert.equal(classifyContentPanelTransportUrl('http://127.0.0.1:8642/outside-base', { settings, runtimeGetUrl }), null);
  assert.equal(classifyContentPanelTransportUrl('https://agent.internal:8643/admin', { settings, runtimeGetUrl }), null);
  assert.equal(classifyContentPanelTransportUrl('https://raw.githubusercontent.com/other/repo/main/package.json', { settings, runtimeGetUrl }), null);
  assert.equal(classifyContentPanelTransportUrl('https://user:pass@models.example/catalog/v1/models', { settings, runtimeGetUrl }), null);
});

test('gateway requests preserve required Hermes headers and reject redirects by construction', () => {
  const prepared = prepareContentPanelHttpRequest({
    url: 'http://127.0.0.1:8642/hermes/api/sessions',
    method: 'POST',
    headers: {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
      Cookie: 'not-allowed',
      'X-Arbitrary': 'not-allowed',
    },
    body: '{"title":"Browser"}',
  }, { settings, runtimeGetUrl });

  assert.equal(prepared.kind, 'gateway');
  assert.equal(prepared.init.redirect, 'error');
  assert.equal(prepared.init.headers.get('authorization'), 'Bearer secret');
  assert.equal(prepared.init.headers.get('content-type'), 'application/json');
  assert.equal(prepared.init.headers.has('cookie'), false);
  assert.equal(prepared.init.headers.has('x-arbitrary'), false);
});

test('credentials and secrets are stripped from non-gateway requests', () => {
  const prepared = prepareContentPanelHttpRequest({
    url: 'https://raw.githubusercontent.com/abundantbeing/hermes-browser-extension/main/package.json',
    method: 'GET',
    credentials: 'include',
    headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
  }, { settings, runtimeGetUrl });
  assert.equal(prepared.init.credentials, 'omit');
  assert.equal(prepared.init.headers.has('authorization'), false);
  assert.equal(prepared.init.headers.get('accept'), 'application/json');
});

test('non-gateway destinations are read-only and GET bodies are rejected', () => {
  assert.throws(() => prepareContentPanelHttpRequest({
    url: 'https://models.example/catalog/v1/models',
    method: 'POST',
    body: '{}',
  }, { settings, runtimeGetUrl }), /method is not allowed/i);
  assert.throws(() => prepareContentPanelHttpRequest({
    url: 'http://127.0.0.1:8642/hermes/health',
    method: 'GET',
    body: '{}',
  }, { settings, runtimeGetUrl }), /cannot include a body/i);
});

test('WebSocket bridge accepts only the approved dashboard ticket endpoint', () => {
  const wsSettings = {
    gatewayUrl: 'https://dashboard.example/hermes',
    trustedDashboardOrigin: 'https://dashboard.example',
  };
  assert.equal(validateContentPanelWebSocketUrl('wss://dashboard.example/hermes/api/ws?ticket=one-time', wsSettings), true);
  assert.equal(validateContentPanelWebSocketUrl('ws://dashboard.example/hermes/api/ws?ticket=one-time', wsSettings), false);
  assert.equal(validateContentPanelWebSocketUrl('wss://other.example/hermes/api/ws?ticket=one-time', wsSettings), false);
  assert.equal(validateContentPanelWebSocketUrl('wss://dashboard.example/api/ws?ticket=one-time', wsSettings), false);
  assert.equal(validateContentPanelWebSocketUrl('wss://dashboard.example/hermes/api/ws?ticket=x&extra=1', wsSettings), false);
});

test('WebSocket bridge sends only known Hermes JSON-RPC methods', () => {
  assert.equal(isAllowedGatewayRpcFrame(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'prompt.submit',
    params: { session_id: 's1', text: 'hello' },
  })), true);
  assert.equal(isAllowedGatewayRpcFrame(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'admin.deleteEverything',
    params: {},
  })), false);
  assert.equal(isAllowedGatewayRpcFrame('not-json'), false);
});

test('HTTP broker cancellation before sender verification never starts fetch', async () => {
  const onConnect = eventChannel();
  let resolveSenderTab;
  let fetchCalls = 0;
  const senderTab = {
    id: 7,
    windowId: 3,
    active: true,
    status: 'complete',
    url: 'https://page.example/',
  };
  const chromeApi = {
    runtime: {
      id: 'hermes',
      getURL: runtimeGetUrl,
      onConnect,
    },
    tabs: {
      get: () => new Promise((resolve) => { resolveSenderTab = resolve; }),
    },
    storage: {
      local: { get: async () => ({ hermesBrowserSettings: settings }) },
    },
  };
  const port = {
    name: 'HERMES_CONTENT_PANEL_HTTP',
    sender: { id: 'hermes', frameId: 0, tab: senderTab },
    sent: [],
    onMessage: eventChannel(),
    onDisconnect: eventChannel(),
    postMessage(message) { this.sent.push(message); },
  };
  installContentPanelTransport({
    chromeApi,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('unexpected');
    },
    WebSocketImpl: null,
  });

  onConnect.emit(port);
  port.onMessage.emit({
    type: 'request',
    request: { url: 'http://127.0.0.1:8642/hermes/health', method: 'GET' },
  });
  port.onMessage.emit({ type: 'cancel' });
  resolveSenderTab(senderTab);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalls, 0);
  assert.equal(port.sent.at(-1)?.type, 'error');
  assert.match(port.sent.at(-1)?.error || '', /cancelled/i);
});
