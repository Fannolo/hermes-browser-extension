import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();

test('browser-runtime.mjs detects Firefox via UA and browser.sidebarAction', () => {
  const source = readFileSync(new URL('../extension/lib/browser-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /Firefox/);
  assert.match(source, /browser\?\.sidebarAction/);
});

test('browser-runtime.mjs openNativeSidebar handles sidebarAction.open() for Firefox', () => {
  const source = readFileSync(new URL('../extension/lib/browser-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /sidebarAction\.open/);
  assert.match(source, /typeof sidebarAction\.open === 'function'/);
});

test('browser-runtime.mjs setActionClickPanelBehavior handles Firefox', () => {
  const source = readFileSync(new URL('../extension/lib/browser-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /BROWSER_IDS\.FIREFOX/);
});

test('background.js openHermesPanel falls back to popup window for Firefox', () => {
  const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(source, /browserId === 'opera' \|\| browserId === 'firefox'/);
  assert.match(source, /windows\.create/);
});

test('build-firefox.mjs exists and is valid JavaScript', () => {
  const buildScript = path.join(root, 'scripts', 'build-firefox.mjs');
  assert.ok(existsSync(buildScript), 'build-firefox.mjs should exist');
  // Syntax check
  execFileSync('node', ['--check', buildScript], { encoding: 'utf8' });
});

test('build-firefox.mjs strips Chrome-only manifest keys and adds Firefox settings', () => {
  const source = readFileSync(new URL('../scripts/build-firefox.mjs', import.meta.url), 'utf8');
  assert.match(source, /delete sourceManifest\.side_panel/);
  assert.match(source, /delete sourceManifest\.minimum_chrome_version/);
  assert.match(source, /sidePanel.*filter|filter.*sidePanel/);
  assert.match(source, /browser_specific_settings/);
  assert.match(source, /gecko/);
});

test('package.json has build:firefox script', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts['build:firefox'], 'build:firefox script should exist');
  assert.match(pkg.scripts['build:firefox'], /build-firefox\.mjs/);
});

test('manifest.json has sidebar_action for Firefox sidebar support', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.sidebar_action, 'sidebar_action must be in manifest for Firefox');
  assert.ok(manifest.sidebar_action.default_panel, 'sidebar_action.default_panel must be set');
  assert.equal(manifest.sidebar_action.default_panel, manifest.side_panel.default_path, 'sidebar_action default_panel must match side_panel default_path');
});

// --- Safari -----------------------------------------------------------------
// These are behavioural, not source-regex: import the real module and stub the
// globals it reads, so we prove the Safari path actually resolves correctly.

import { execFileSync as _exec } from 'node:child_process';

function withGlobals(stub, fn) {
  const savedChrome = globalThis.chrome;
  const savedBrowser = globalThis.browser;
  const savedOpr = globalThis.opr;
  try {
    globalThis.chrome = stub.chrome;
    globalThis.browser = stub.browser;
    globalThis.opr = stub.opr;
    return fn();
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.browser = savedBrowser;
    globalThis.opr = savedOpr;
  }
}

const safariChrome = { runtime: { getURL: (p) => `safari-web-extension://ABC-123/${p}` } };
const chromiumChrome = {
  runtime: { getURL: (p) => `chrome-extension://abcdefg/${p}` },
  sidePanel: { open: () => {}, setPanelBehavior: () => {}, setOptions: () => {} },
};

test('detectBrowserId returns safari for the safari-web-extension:// scheme', async () => {
  const { detectBrowserId, BROWSER_IDS } = await import('../extension/lib/browser-runtime.mjs');
  const id = withGlobals({ chrome: safariChrome }, () => detectBrowserId());
  assert.equal(id, BROWSER_IDS.SAFARI);
});

test('Safari scheme detection wins over the UA string (every Chromium UA also says "Safari")', async () => {
  const { detectBrowserId, BROWSER_IDS } = await import('../extension/lib/browser-runtime.mjs');
  // Chromium: scheme is chrome-extension://, so must NOT be detected as Safari.
  const id = withGlobals({ chrome: chromiumChrome }, () => detectBrowserId());
  assert.equal(id, BROWSER_IDS.CHROMIUM);
});

test('Safari exposes no sidebar API: hasChromeSidePanel and hasSidebarAction are both false', async () => {
  const { hasChromeSidePanel, hasSidebarAction } = await import('../extension/lib/browser-runtime.mjs');
  withGlobals({ chrome: safariChrome }, () => {
    assert.equal(hasChromeSidePanel(), false, 'Safari has no chrome.sidePanel');
    assert.equal(hasSidebarAction(), false, 'Safari has no sidebarAction');
  });
});

test('nativePanelMode resolves to extension-window on Safari (not extension-tab)', async () => {
  const { nativePanelMode } = await import('../extension/lib/browser-runtime.mjs');
  const mode = withGlobals({ chrome: safariChrome }, () => nativePanelMode());
  assert.equal(mode, 'extension-window');
});

test('openNativeSidebar returns false on Safari so the caller falls back', async () => {
  const { openNativeSidebar } = await import('../extension/lib/browser-runtime.mjs');
  const opened = await withGlobals({ chrome: safariChrome }, () => openNativeSidebar({ windowId: 1 }));
  assert.equal(opened, false, 'Safari must not claim it opened a native sidebar');
});

test('setActionClickPanelBehavior does not throw on Safari (no sidePanel API)', async () => {
  const { setActionClickPanelBehavior } = await import('../extension/lib/browser-runtime.mjs');
  await withGlobals({ chrome: safariChrome }, async () => {
    await setActionClickPanelBehavior();
  });
});

test('background.js routes Safari to the detached window path', () => {
  const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(source, /browserId === 'safari'/);
});

test('build-safari.mjs exists and is valid JavaScript', () => {
  const buildScript = path.join(root, 'scripts', 'build-safari.mjs');
  assert.ok(existsSync(buildScript), 'build-safari.mjs should exist');
  _exec('node', ['--check', buildScript], { encoding: 'utf8' });
});

test('build-safari.mjs strips both sidebar APIs Safari cannot implement', () => {
  const source = readFileSync(new URL('../scripts/build-safari.mjs', import.meta.url), 'utf8');
  assert.match(source, /delete sourceManifest\.side_panel/, 'must strip Chromium side_panel');
  assert.match(source, /delete sourceManifest\.sidebar_action/, 'must strip Firefox sidebar_action');
  assert.match(source, /_execute_sidebar_action/, 'must strip the Firefox-reserved command');
  assert.match(source, /filter\(\(p\) => p !== 'sidePanel'\)/, 'must strip the sidePanel permission');
});

test('package.json has build:safari script', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts['build:safari'], 'build:safari script should exist');
  assert.match(pkg.scripts['build:safari'], /build-safari\.mjs/);
});
