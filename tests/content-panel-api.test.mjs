import test from 'node:test';
import assert from 'node:assert/strict';

import {
  callContentPanelApi,
  CONTENT_PANEL_API_MESSAGE,
  CONTENT_PANEL_API_OPERATIONS,
  CONTENT_PANEL_PAGE_COMMANDS,
  createContentPanelApiHandler,
} from '../extension/lib/content-panel-api.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const tabs = new Map([
    [7, { id: 7, windowId: 3, active: true, status: 'complete', title: 'Host', url: 'https://page.example/path' }],
    [8, { id: 8, windowId: 3, active: false, status: 'complete', title: 'Video', url: 'https://www.youtube.com/watch?v=abc123xyz00' }],
    [9, { id: 9, windowId: 4, active: true, status: 'complete', title: 'Other', url: 'https://other.example/' }],
  ]);
  const settings = {
    gatewayUrl: 'http://127.0.0.1:8642',
    transcriptProvider: 'default',
    trustedDashboardOrigin: 'https://dashboard.example',
    ...overrides.settings,
  };
  const chromeApi = {
    runtime: {
      id: 'hermes-extension',
      getURL: (path) => `safari-web-extension://hermes/${path}`,
      sendMessage: async (message) => {
        calls.push(['runtime.sendMessage', message]);
        return { ok: true, value: 'client-value' };
      },
    },
    storage: {
      local: {
        get: async () => ({ hermesBrowserSettings: settings }),
      },
    },
    tabs: {
      get: async (tabId) => {
        calls.push(['tabs.get', tabId]);
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error('missing tab');
        return { ...tab };
      },
      query: async (query) => {
        calls.push(['tabs.query', query]);
        return Array.from(tabs.values()).filter((tab) => (
          (query.windowId == null || tab.windowId === query.windowId)
          && (query.active == null || tab.active === query.active)
        ));
      },
      sendMessage: async (tabId, payload) => {
        calls.push(['tabs.sendMessage', tabId, payload]);
        return { ok: true, source: 'page' };
      },
      create: async (properties) => {
        calls.push(['tabs.create', properties]);
        return { id: 20, windowId: 3, ...properties };
      },
    },
    scripting: { executeScript: async () => [] },
    ...overrides.chromeApi,
  };
  const sender = {
    id: 'hermes-extension',
    frameId: 0,
    tab: { ...tabs.get(7) },
    ...overrides.sender,
  };
  return { calls, chromeApi, sender, settings, tabs };
}

function request(operation, args = {}) {
  return { type: CONTENT_PANEL_API_MESSAGE, operation, args };
}

test('content panel snapshot is limited to the sender window and sanitized', async () => {
  const { chromeApi, sender } = fixture();
  const handle = createContentPanelApiHandler({ chromeApi });
  const response = await handle(request(CONTENT_PANEL_API_OPERATIONS.TAB_SNAPSHOT), sender);

  assert.equal(response.ok, true);
  assert.deepEqual(response.value.tabs.map((tab) => tab.id), [7, 8]);
  assert.equal(response.value.activeTab.id, 7);
  assert.equal(response.value.hostTab.url, 'https://page.example/path');
  assert.equal('cookieStoreId' in response.value.hostTab, false);
});

test('content panel rejects extension pages, foreign extensions, and subframes', async () => {
  const { chromeApi, sender } = fixture();
  const handle = createContentPanelApiHandler({ chromeApi });

  const noTab = await handle(request(CONTENT_PANEL_API_OPERATIONS.TAB_SNAPSHOT), { id: 'hermes-extension' });
  assert.equal(noTab.code, 'invalid_sender_tab');
  const foreign = await handle(request(CONTENT_PANEL_API_OPERATIONS.TAB_SNAPSHOT), { ...sender, id: 'other' });
  assert.equal(foreign.code, 'foreign_sender');
  const subframe = await handle(request(CONTENT_PANEL_API_OPERATIONS.TAB_SNAPSHOT), { ...sender, frameId: 2 });
  assert.equal(subframe.code, 'subframe_sender');
});

test('tab reads and page commands cannot cross browser windows', async () => {
  const { chromeApi, sender, calls } = fixture();
  const handle = createContentPanelApiHandler({ chromeApi });

  const rejected = await handle(request(CONTENT_PANEL_API_OPERATIONS.TAB_GET, { tabId: 9 }), sender);
  assert.equal(rejected.code, 'cross_window_tab');

  const response = await handle(request(CONTENT_PANEL_API_OPERATIONS.PAGE_COMMAND, {
    tabId: 8,
    command: CONTENT_PANEL_PAGE_COMMANDS.GET_CONTEXT,
    depth: 'full',
    payload: { type: 'ARBITRARY' },
  }), sender);
  assert.equal(response.ok, true);
  assert.deepEqual(calls.at(-1), [
    'tabs.sendMessage',
    8,
    { type: 'HERMES_GET_PAGE_CONTEXT', options: { depth: 'full' } },
  ]);
});

test('page command names and context depth are allowlisted', async () => {
  const { chromeApi, sender, calls } = fixture();
  const handle = createContentPanelApiHandler({ chromeApi });
  const rejected = await handle(request(CONTENT_PANEL_API_OPERATIONS.PAGE_COMMAND, {
    tabId: 8,
    command: 'tabs.executeAnything',
  }), sender);
  assert.equal(rejected.code, 'unknown_page_command');

  await handle(request(CONTENT_PANEL_API_OPERATIONS.PAGE_COMMAND, {
    tabId: 8,
    command: CONTENT_PANEL_PAGE_COMMANDS.GET_CONTEXT,
    depth: 'unbounded',
  }), sender);
  assert.deepEqual(calls.at(-1)[2], { type: 'HERMES_GET_PAGE_CONTEXT', options: { depth: 'normal' } });
});

test('pairing approval can open only on the configured gateway origin', async () => {
  const { chromeApi, sender, calls } = fixture();
  const handle = createContentPanelApiHandler({ chromeApi });
  const allowed = await handle(request(CONTENT_PANEL_API_OPERATIONS.OPEN_PAIRING_APPROVAL, {
    url: 'http://127.0.0.1:8642/pair/approve?id=1',
  }), sender);
  assert.equal(allowed.ok, true);
  assert.deepEqual(calls.at(-1), ['tabs.create', { url: 'http://127.0.0.1:8642/pair/approve?id=1', active: true }]);

  const rejected = await handle(request(CONTENT_PANEL_API_OPERATIONS.OPEN_PAIRING_APPROVAL, {
    url: 'https://attacker.example/pair',
  }), sender);
  assert.equal(rejected.code, 'untrusted_approval_url');
});

test('transcript operation derives the video id and provider instead of trusting the message', async () => {
  const { chromeApi, sender } = fixture({ settings: { transcriptProvider: 'off' } });
  const calls = [];
  const handle = createContentPanelApiHandler({
    chromeApi,
    transcriptResolver: async (input) => {
      calls.push(input);
      return { ok: false, reason: 'transcripts_disabled' };
    },
  });
  const response = await handle(request(CONTENT_PANEL_API_OPERATIONS.TRANSCRIPT_GET, {
    tabId: 8,
    videoId: 'forged',
    provider: 'https://attacker.example',
  }), sender);
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{ videoId: 'abc123xyz00', tabId: 8, provider: 'off' }]);
});

test('dashboard mint uses only an active same-window tab and an approved origin', async () => {
  const { chromeApi, sender, tabs } = fixture();
  tabs.set(7, { ...tabs.get(7), active: false });
  tabs.set(8, {
    ...tabs.get(8),
    active: true,
    url: 'https://dashboard.example/app',
    title: 'Dashboard',
  });
  const mintCalls = [];
  const handle = createContentPanelApiHandler({
    chromeApi,
    mintDashboardTicket: async (input) => {
      mintCalls.push(input);
      assert.deepEqual((await input.tabsApi.query()).map((tab) => tab.id), [8]);
      assert.equal((await input.tabsApi.get(8)).id, 8);
      return { ok: true, ticket: 'ticket', ttlSeconds: 30 };
    },
  });

  const found = await handle(request(CONTENT_PANEL_API_OPERATIONS.DASHBOARD_FIND, {
    baseUrl: 'https://dashboard.example',
    tabId: 8,
  }), sender);
  assert.equal(found.value.id, 8);
  const minted = await handle(request(CONTENT_PANEL_API_OPERATIONS.DASHBOARD_MINT, {
    baseUrl: 'https://dashboard.example',
    tabId: 8,
  }), sender);
  assert.equal(minted.value.ticket, 'ticket');
  assert.equal(mintCalls[0].tabId, 8);

  const rejected = await handle(request(CONTENT_PANEL_API_OPERATIONS.DASHBOARD_MINT, {
    baseUrl: 'https://different.example',
    tabId: 8,
  }), sender);
  assert.equal(rejected.code, 'dashboard_origin_untrusted');
});

test('content panel client uses the single typed runtime message and unwraps responses', async () => {
  const { chromeApi, calls } = fixture();
  const value = await callContentPanelApi('tabs.snapshot', { ignored: true }, { chromeApi });
  assert.equal(value, 'client-value');
  assert.deepEqual(calls.at(-1), ['runtime.sendMessage', {
    type: CONTENT_PANEL_API_MESSAGE,
    operation: 'tabs.snapshot',
    args: { ignored: true },
  }]);
});
