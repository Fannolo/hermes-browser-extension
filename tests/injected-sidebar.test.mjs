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

const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// --- The duplicated contract ------------------------------------------------
// content.js is a classic content script and cannot import the module, so it
// re-declares these values. If the two ever drift, the sidebar silently stops
// mounting and every Safari user falls back to the detached window with no
// error. Pin them.

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

// --- Blocked-frame detection ------------------------------------------------

test('the panel announces READY to its parent so a blocked frame can be told from a live one', () => {
  assert.match(panelSource, /HERMES_SIDEBAR_READY/);
  assert.match(panelSource, /parent\.postMessage/);
});

test('content.js falls back on timeout rather than trusting the iframe load event', () => {
  // A CSP-blocked frame still fires `load` for about:blank, so a load handler
  // would report success for a frame that never rendered the panel.
  assert.match(contentSource, /blocked:\s*true/, 'must report blocked on timeout');
  assert.ok(
    !/iframe\.addEventListener\(\s*['"]load['"]/.test(contentSource),
    'must not treat the iframe load event as proof the panel mounted',
  );
});

test('content.js verifies postMessage by source, not origin', () => {
  // The extension origin differs per install on Safari, and a blocked frame can
  // report a null origin — so origin checks are the wrong tool here.
  assert.match(contentSource, /event\.source !== iframe\.contentWindow/);
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

test('background gives the content script longer than its own READY timeout', () => {
  // Racing the content script's timeout would abandon a mount that is still viable.
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

test('background injects the content script on demand instead of requiring a page reload', () => {
  // Tabs opened before the extension was installed/updated have a stale content
  // script or none. Reloading must not be the user's job.
  assert.match(backgroundSource, /chrome\.scripting\.executeScript\(\{ target: \{ tabId \}, files: \['content\.js'\] \}\)/);
  assert.match(backgroundSource, /const retry = await sendSidebarToggle\(tabId, panelPath\)/);
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
