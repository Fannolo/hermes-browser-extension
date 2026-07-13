import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_PANEL_EVENTS_PORT,
  createContentPanelChromeFacade,
  installContentPanelEventBroker,
} from '../extension/lib/content-panel-runtime.mjs';
import { CONTENT_PANEL_API_OPERATIONS } from '../extension/lib/content-panel-api.mjs';

function eventChannel() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); },
  };
}

function fakePort(name = CONTENT_PANEL_EVENTS_PORT) {
  return {
    name,
    sender: {
      id: 'hermes',
      frameId: 0,
      tab: { id: 7, windowId: 3, active: true, status: 'complete', url: 'https://page.example/' },
    },
    sent: [],
    onMessage: eventChannel(),
    onDisconnect: eventChannel(),
    postMessage(message) { this.sent.push(message); },
    disconnect() { this.onDisconnect.emit(); },
  };
}

test('Chrome facade maps tabs, transcript, and permission calls to semantic operations', async () => {
  const calls = [];
  const port = fakePort();
  const chromeApi = {
    runtime: {
      id: 'hermes',
      getURL: (path) => `safari-web-extension://hermes/${path}`,
      connect: ({ name }) => {
        assert.equal(name, CONTENT_PANEL_EVENTS_PORT);
        return port;
      },
      sendMessage: async (message) => {
        calls.push(message);
        if (message.operation === CONTENT_PANEL_API_OPERATIONS.TAB_SNAPSHOT) {
          return { ok: true, value: { tabs: [{ id: 7, windowId: 3, active: true }] } };
        }
        if (message.operation === CONTENT_PANEL_API_OPERATIONS.PAGE_COMMAND) {
          return { ok: true, value: { ok: true } };
        }
        if (message.operation === CONTENT_PANEL_API_OPERATIONS.TRANSCRIPT_GET) {
          return { ok: true, value: { ok: true, text: 'captions' } };
        }
        if (message.operation === CONTENT_PANEL_API_OPERATIONS.AUDIO_PERMISSION) {
          return { ok: true, value: true };
        }
        return { ok: true, value: null };
      },
      onMessage: eventChannel(),
    },
    storage: { local: {}, onChanged: eventChannel() },
  };
  const facade = createContentPanelChromeFacade({ chromeApi });

  assert.deepEqual(await facade.tabs.query({ active: true, currentWindow: true }), [{ id: 7, windowId: 3, active: true }]);
  assert.deepEqual(await facade.tabs.sendMessage(7, { type: 'HERMES_GET_PAGE_CONTEXT', options: { depth: 'full' } }), { ok: true });
  assert.deepEqual(await facade.runtime.sendMessage({ type: 'HERMES_GET_YOUTUBE_TRANSCRIPT', tabId: 7 }), { ok: true, text: 'captions' });
  assert.equal(await facade.permissions.request({ permissions: ['audioCapture'] }), true);

  assert.equal(calls[1].operation, CONTENT_PANEL_API_OPERATIONS.PAGE_COMMAND);
  assert.deepEqual(calls[1].args, { tabId: 7, command: 'context.get', depth: 'full' });
  assert.equal(calls[2].operation, CONTENT_PANEL_API_OPERATIONS.TRANSCRIPT_GET);
});

test('Chrome facade turns broker tab events and picker echoes into Chrome-style listeners', () => {
  const port = fakePort();
  const nativeOnMessage = eventChannel();
  const chromeApi = {
    runtime: {
      id: 'hermes',
      getURL: (path) => `safari-web-extension://hermes/${path}`,
      connect: () => port,
      sendMessage: async () => ({ ok: true, value: null }),
      onMessage: nativeOnMessage,
    },
  };
  const facade = createContentPanelChromeFacade({ chromeApi });
  const seen = [];
  facade.tabs.onUpdated.addListener((...args) => seen.push(['updated', ...args]));
  facade.runtime.onMessage.addListener((message, sender) => seen.push(['runtime', message, sender]));

  port.onMessage.emit({ type: 'tabs.updated', tabId: 7, changeInfo: { title: 'New' }, tab: { id: 7 } });
  port.onMessage.emit({
    type: 'runtime.message',
    message: { type: 'HERMES_ELEMENT_PICK_RESULT', selector: '#main' },
    senderTab: { id: 7, windowId: 3 },
  });

  assert.deepEqual(seen[0], ['updated', 7, { title: 'New' }, { id: 7 }]);
  assert.equal(seen[1][0], 'runtime');
  assert.equal(seen[1][1].selector, '#main');
  assert.equal(seen[1][2].tab.id, 7);
});

test('Chrome facade reconnects its event port after the background worker disconnects', () => {
  const ports = [fakePort(), fakePort()];
  const timers = [];
  let connectionCount = 0;
  const chromeApi = {
    runtime: {
      id: 'hermes',
      getURL: (path) => `safari-web-extension://hermes/${path}`,
      connect: () => ports[connectionCount++],
      sendMessage: async () => ({ ok: true, value: null }),
      onMessage: eventChannel(),
    },
  };
  const facade = createContentPanelChromeFacade({
    chromeApi,
    setTimeoutImpl(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
  });
  const seen = [];
  facade.tabs.onUpdated.addListener((tabId) => seen.push(tabId));

  ports[0].disconnect();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 250);
  timers.shift().callback();
  assert.equal(connectionCount, 2);

  ports[1].onMessage.emit({ type: 'tabs.updated', tabId: 9, changeInfo: {}, tab: { id: 9 } });
  assert.deepEqual(seen, [9]);
});

test('background event broker echoes element-picker results only inside the sender window', async () => {
  const onConnect = eventChannel();
  const onActivated = eventChannel();
  const onUpdated = eventChannel();
  const onRemoved = eventChannel();
  const tabs = new Map([
    [7, { id: 7, windowId: 3, active: true, status: 'complete', url: 'https://page.example/' }],
  ]);
  const chromeApi = {
    runtime: { id: 'hermes', onConnect },
    tabs: {
      get: async (id) => tabs.get(id),
      onActivated,
      onUpdated,
      onRemoved,
    },
  };
  const broker = installContentPanelEventBroker({ chromeApi });
  const port = fakePort();
  onConnect.emit(port);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(broker.echoRuntimeMessage(
    { type: 'HERMES_ELEMENT_PICK_RESULT', selector: '#main' },
    { tab: tabs.get(7) },
  ), true);
  assert.equal(port.sent.at(-1).type, 'runtime.message');
  assert.equal(port.sent.at(-1).message.selector, '#main');
  assert.equal(broker.echoRuntimeMessage({ type: 'ARBITRARY' }, { tab: tabs.get(7) }), false);
});
