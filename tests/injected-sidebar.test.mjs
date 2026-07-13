import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  canInjectSidebar,
  clampSidebarWidth,
  DEFAULT_SIDEBAR_PRESENTATION,
  normalizeSidebarPresentation,
  READY_TIMEOUT_MS,
  SIDEBAR_HOST_ID,
  SIDEBAR_MESSAGES,
  SIDEBAR_PRESENTATION,
  SIDEBAR_WIDTH,
} from '../extension/lib/injected-sidebar.mjs';
import {
  canRelayTabMessage,
  isEmbeddedSafariPanel,
  sendTabMessage,
  TAB_MESSAGE_RELAY,
} from '../extension/lib/tab-messaging.mjs';

const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const readySource = readFileSync(new URL('../extension/sidebar-ready.js', import.meta.url), 'utf8');
const panelHtml = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// --- The duplicated contract ------------------------------------------------
// content.js is a classic content script and cannot import the module, so it
// re-declares these values. If the two ever drift, the sidebar can stop
// mounting. Pin them.

test('content.js mirrors the sidebar message names exactly', () => {
  for (const value of Object.values(SIDEBAR_MESSAGES)) {
    assert.ok(contentSource.includes(`'${value}'`), `content.js must declare ${value}`);
  }
});

test('content.js mirrors the host id and the READY timeout', () => {
  assert.ok(contentSource.includes(`'${SIDEBAR_HOST_ID}'`), 'host id must match');
  assert.ok(
    contentSource.includes(String(READY_TIMEOUT_MS)),
    `content.js must use the shared READY timeout (${READY_TIMEOUT_MS}ms)`,
  );
});

test('content.js mirrors the width bounds', () => {
  for (const key of ['DEFAULT', 'MIN', 'MAX']) {
    assert.ok(
      contentSource.includes(String(SIDEBAR_WIDTH[key])),
      `content.js must use width ${key}=${SIDEBAR_WIDTH[key]}`,
    );
  }
  assert.ok(contentSource.includes(SIDEBAR_WIDTH.STORAGE_KEY), 'width storage key must match');
});

// --- Persistent host lifecycle ---------------------------------------------

test('the panel announces READY to its parent for diagnostics', () => {
  assert.match(readySource, /HERMES_SIDEBAR_READY/);
  assert.match(readySource, /parent\.postMessage/);
});

test('the handshake loads before sidepanel.js so a panel startup error cannot suppress it', () => {
  // If the ping lived inside sidepanel.js, any throw in its import graph or init
  // would suppress useful diagnostics.
  // Match the src attributes, not bare filenames — prose in comments would
  // otherwise satisfy the ordering check.
  const readyAt = panelHtml.indexOf('src="sidebar-ready.js"');
  const panelAt = panelHtml.indexOf('src="sidepanel.js"');
  assert.ok(readyAt > -1, 'sidepanel.html must load sidebar-ready.js');
  assert.ok(panelAt > -1, 'sidepanel.html must load sidepanel.js');
  assert.ok(readyAt < panelAt, 'sidebar-ready.js must load before sidepanel.js');
});

test('the handshake re-announces on DOMContentLoaded and load', () => {
  // The content script may attach its listener after the frame starts executing.
  assert.match(readySource, /DOMContentLoaded/);
  assert.match(readySource, /'load'/);
});

test('a missed READY handshake never removes the mounted sidebar', () => {
  const timeoutAt = contentSource.indexOf('const readyTimer = setTimeout');
  const timeoutEnd = contentSource.indexOf('\n  }, SIDEBAR_READY_TIMEOUT_MS);', timeoutAt);
  const timeoutBody = contentSource.slice(timeoutAt, timeoutEnd);
  assert.match(timeoutBody, /keeping the mounted sidebar open/);
  assert.doesNotMatch(timeoutBody, /destroySidebar|\.remove\(\)|blocked:\s*true/);
  assert.ok(
    !/iframe\.addEventListener\(\s*['"]load['"]/.test(contentSource),
    'must not treat the iframe load event as proof of READY',
  );
});

test('content.js uses an off-canvas class transition and keeps the host mounted', () => {
  assert.match(contentSource, /SIDEBAR_OPEN_CLASS = 'hermes-sidebar-open'/);
  assert.match(contentSource, /translate3d\(100%, 0, 0\)/);
  assert.match(contentSource, /cubic-bezier\(\.16, 1, \.3, 1\)/);
  assert.match(contentSource, /classList\.toggle\(SIDEBAR_OPEN_CLASS, open\)/);
  assert.match(contentSource, /current conversation/);
});

test('the Safari bundle mounts the panel directly in the ShadowRoot', () => {
  assert.match(contentSource, /DIRECT_PANEL_ASSETS_GLOBAL = '__HERMES_DIRECT_PANEL_ASSETS__'/);
  const start = contentSource.indexOf('function mountDirectSidebar');
  const end = contentSource.indexOf('\n}\n\n/**', start) + 3;
  const body = contentSource.slice(start, end);
  assert.match(body, /document\.createElement\('div'\)/);
  assert.match(body, /globalThis\[PANEL_MOUNT_GLOBAL\] =/);
  assert.match(body, /\.then\(\(\) => assets\.load\(\)\)/);
  assert.doesNotMatch(body, /createElement\(['"]iframe['"]\)|<iframe|postMessage|SIDEBAR_MESSAGES\.READY/);
});

test('the direct Hermes panel uses a closed ShadowRoot', () => {
  const directMount = contentSource.slice(
    contentSource.indexOf('function mountDirectSidebar'),
    contentSource.indexOf('function mountSidebar', contentSource.indexOf('function mountDirectSidebar')),
  );
  assert.match(directMount, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.doesNotMatch(directMount, /attachShadow\(\{ mode: 'open' \}\)/);
});

test('the existing panel code resolves a scoped document before querying controls', () => {
  const resolverAt = panelSource.indexOf('const document = resolvePanelDocument(globalThis)');
  const firstQueryAt = panelSource.indexOf("const $ = (selector) => document.querySelector(selector)");
  assert.ok(resolverAt > -1, 'sidepanel.js must resolve its DOM boundary');
  assert.ok(firstQueryAt > resolverAt, 'the boundary must be ready before the first control lookup');
});

test('panel markup and styles support both extension documents and ShadowRoot documents', () => {
  assert.match(panelHtml, /<html class="hermes-panel-root"/);
  assert.match(panelHtml, /<body class="hermes-panel-body"/);
  assert.match(panelCss, /:root,\s*\.hermes-panel-root\s*\{/);
  assert.match(contentSource, /replace\(\/\\bhtml\(\?=\\\[\|,\)\/g, '\.hermes-panel-root'\)/);
  assert.match(contentSource, /replace\(\/\\bbody\(\?=\\s\*\(\?:,\|\\\{\)\)\/g, '\.hermes-panel-body'\)/);
});

test('sidebar toggle responds synchronously instead of holding Safari message channels open', () => {
  const start = contentSource.indexOf("if (message?.type === SIDEBAR_MESSAGES.TOGGLE");
  const end = contentSource.indexOf("if (message?.type === 'HERMES_GET_PAGE_CONTEXT'", start);
  const body = contentSource.slice(start, end);
  assert.match(body, /sendResponse\(run\(message\.url\)\)/);
  assert.doesNotMatch(body, /\.then\(sendResponse\)/);
  assert.match(body, /return false/);
});

// --- Fallback wiring --------------------------------------------------------

test('background only prefers the injected sidebar on Safari', () => {
  assert.match(backgroundSource, /detectBrowserId\(\) === BROWSER_IDS\.SAFARI && await injectedSidebarPreferred\(\)/);
});

test('background falls through to the detached window when injection fails', () => {
  assert.match(backgroundSource, /if \(await tryInjectedSidebar\(tab, panelPath\)\) return;/);
  // The detached-window path must still be reachable below it.
  assert.match(backgroundSource, /windows\.create/);
});

test('background has a defensive mount response timeout', () => {
  assert.match(backgroundSource, /SIDEBAR_READY_TIMEOUT_MS \+ \d+/);
});

test('background bails out of injection on pages that cannot host it', () => {
  assert.match(backgroundSource, /if \(!canInjectSidebar\(tab\?\.url\)\) \{/);
  assert.match(backgroundSource, /Injected sidebar unavailable on this page/);
});

// --- Pure helpers -----------------------------------------------------------

test('canInjectSidebar allows only http(s) pages', () => {
  assert.equal(canInjectSidebar('https://example.com'), true);
  assert.equal(canInjectSidebar('http://example.com'), true);
  // The content script does not run on these, so injection is impossible.
  assert.equal(canInjectSidebar('about:blank'), false);
  assert.equal(canInjectSidebar('safari-web-extension://abc/sidepanel.html'), false);
  assert.equal(canInjectSidebar('file:///tmp/a.pdf'), false);
  assert.equal(canInjectSidebar(''), false);
  assert.equal(canInjectSidebar(undefined), false);
});

test('clampSidebarWidth keeps the sidebar usable', () => {
  assert.equal(clampSidebarWidth(500), 500);
  assert.equal(clampSidebarWidth(10), SIDEBAR_WIDTH.MIN);
  assert.equal(clampSidebarWidth(99999), SIDEBAR_WIDTH.MAX);
  assert.equal(clampSidebarWidth('nonsense'), SIDEBAR_WIDTH.DEFAULT);
  assert.equal(clampSidebarWidth(undefined), SIDEBAR_WIDTH.DEFAULT);
  assert.equal(clampSidebarWidth(420.6), 421);
});

test('normalizeSidebarPresentation defaults to injected and only accepts known modes', () => {
  assert.equal(normalizeSidebarPresentation('window'), SIDEBAR_PRESENTATION.WINDOW);
  assert.equal(normalizeSidebarPresentation('injected'), SIDEBAR_PRESENTATION.INJECTED);
  assert.equal(normalizeSidebarPresentation('garbage'), SIDEBAR_PRESENTATION.INJECTED);
  assert.equal(normalizeSidebarPresentation(undefined), DEFAULT_SIDEBAR_PRESENTATION);
});

test('the presentation setting ships with a default', async () => {
  const { DEFAULT_SETTINGS } = await import('../extension/lib/common.mjs');
  assert.equal(
    normalizeSidebarPresentation(DEFAULT_SETTINGS.sidebarPresentation),
    SIDEBAR_PRESENTATION.INJECTED,
  );
});

test('background never dynamically injects the Safari sidebar content script', () => {
  const start = backgroundSource.indexOf('async function tryInjectedSidebar');
  const end = backgroundSource.indexOf('\nasync function openHermesPanel', start);
  const body = backgroundSource.slice(start, end);
  assert.doesNotMatch(body, /chrome\.scripting\.executeScript/);
  assert.match(body, /without reloading the page/);
});

test('content.js is safe to inject twice', () => {
  // On-demand injection can land on a tab that already has the script.
  assert.match(contentSource, /__HERMES_BROWSER_CONTENT_LISTENER__/);
  assert.match(contentSource, /removeListener\(previousListener\)/);
});

test('sidepanel.html is web-accessible so it can load in an in-page iframe', () => {
  // Without this the browser refuses to load the panel from a page context and
  // the sidebar renders nothing at all — no error, just an empty frame.
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const war = manifest.web_accessible_resources;
  assert.ok(Array.isArray(war) && war.length, 'manifest must declare web_accessible_resources');
  const entry = war.find((item) => (item.resources || []).includes('sidepanel.html'));
  assert.ok(entry, 'sidepanel.html must be web-accessible');
  assert.deepEqual(entry.matches, ['http://*/*', 'https://*/*'], 'exposed only to the pages the content script runs on');
});

test('the Safari build keeps web_accessible_resources', () => {
  const source = readFileSync(new URL('../scripts/build-safari.mjs', import.meta.url), 'utf8');
  assert.ok(
    !/delete sourceManifest\.web_accessible_resources/.test(source),
    'the Safari build must not strip web_accessible_resources — the injected sidebar needs it',
  );
});

test('the panel pings through the tab-message abstraction before injecting', () => {
  // On Safari chrome.scripting.executeScript({files}) RELOADS the target page to
  // perform the injection. When the panel runs inside the injected sidebar, the
  // target tab is the page hosting it — so a blind inject reloads the host page,
  // destroys the sidebar, and falls back to a window. Every open. Ping first.
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const ensure = panel.slice(panel.indexOf('async function ensureContentScript'));
  const body = ensure.slice(0, ensure.indexOf('\n}\n') + 3);
  const pingAt = body.indexOf("sendPanelTabMessage(tabId, { type: 'HERMES_PING' })");
  const injectAt = body.indexOf('executeScript');
  assert.ok(pingAt > -1, 'ensureContentScript must ping the content script first');
  assert.ok(injectAt > -1, 'ensureContentScript must still be able to inject');
  assert.ok(pingAt < injectAt, 'the ping must come before the injection');
  assert.match(
    panel,
    /function sendPanelTabMessage[\s\S]*sendTabMessage\(tabId, payload, \{ chromeApi: chrome \}\)/,
    'the panel tab-message abstraction must use the resolved Chrome facade',
  );
});

test('the content script answers the ping', () => {
  assert.match(contentSource, /message\?\.type === 'HERMES_PING'/);
  assert.match(contentSource, /sendResponse\(\{ ok: true, version: CONTENT_SCRIPT_VERSION \}\)/);
});

test('embedded Safari panels are detected without UA sniffing', () => {
  const top = {};
  assert.equal(isEmbeddedSafariPanel({ safari: true, parentWindow: {}, currentWindow: top }), true);
  assert.equal(isEmbeddedSafariPanel({ safari: true, parentWindow: top, currentWindow: top }), false);
  assert.equal(isEmbeddedSafariPanel({ safari: false, parentWindow: {}, currentWindow: top }), false);
});

test('the Safari iframe relays content messages through the background worker', async () => {
  const calls = [];
  const chromeApi = {
    runtime: {
      sendMessage: async (message) => {
        calls.push(['runtime', message]);
        return { ok: true, response: { ok: true, source: 'content-script' } };
      },
    },
    tabs: {
      sendMessage: async (...args) => {
        calls.push(['tabs', args]);
        return null;
      },
    },
  };
  const response = await sendTabMessage(42, { type: 'HERMES_PING' }, { chromeApi, embeddedSafari: true });
  assert.deepEqual(response, { ok: true, source: 'content-script' });
  assert.deepEqual(calls, [[
    'runtime',
    { type: TAB_MESSAGE_RELAY, tabId: 42, payload: { type: 'HERMES_PING' } },
  ]]);
});

test('ordinary extension pages keep direct tab messaging', async () => {
  const calls = [];
  const chromeApi = {
    runtime: { sendMessage: async () => null },
    tabs: {
      sendMessage: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
    },
  };
  assert.deepEqual(
    await sendTabMessage(7, { type: 'HERMES_PING' }, { chromeApi, embeddedSafari: false }),
    { ok: true },
  );
  assert.deepEqual(calls, [[7, { type: 'HERMES_PING' }]]);
});

test('the background relay accepts only known content-script messages', () => {
  assert.equal(canRelayTabMessage(1, { type: 'HERMES_GET_PAGE_CONTEXT' }), true);
  assert.equal(canRelayTabMessage(1, { type: 'HERMES_START_ELEMENT_PICK' }), true);
  assert.equal(canRelayTabMessage(0, { type: 'HERMES_PING' }), false);
  assert.equal(canRelayTabMessage(1, { type: 'UNKNOWN' }), false);
  assert.match(backgroundSource, /message\?\.type === TAB_MESSAGE_RELAY/);
});

test('embedded Safari context fallback never calls executeScript', () => {
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const start = panel.indexOf('async function getPageContextViaScripting');
  const end = panel.indexOf('\nasync function getPageContext', start);
  const body = panel.slice(start, end);
  const guardAt = body.indexOf('if (isEmbeddedSafariPanel())');
  const injectAt = body.indexOf('chrome.scripting.executeScript');
  assert.ok(guardAt > -1 && injectAt > guardAt, 'Safari guard must precede executeScript');
});
