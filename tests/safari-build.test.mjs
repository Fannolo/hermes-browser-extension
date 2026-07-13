import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const safariDist = path.join(root, 'dist', 'safari');
const bundleName = 'safari-content.bundle.js';

test('Safari build emits one self-contained classic content bundle', () => {
  execFileSync(process.execPath, ['scripts/build-safari.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(safariDist, 'manifest.json'), 'utf8'));
  const scripts = (manifest.content_scripts || []).flatMap((entry) => entry.js || []);
  assert.deepEqual(scripts, [bundleName]);

  const bundlePath = path.join(safariDist, bundleName);
  assert.ok(fs.existsSync(bundlePath), 'Safari content bundle must exist');
  assert.equal(
    fs.existsSync(path.join(safariDist, 'safari-content-entry.js')),
    false,
    'the ESM source entry must not ship in the Safari payload',
  );

  const bundle = fs.readFileSync(bundlePath, 'utf8');
  assert.match(bundle, /__HERMES_DIRECT_PANEL_ASSETS__/);
  assert.match(bundle, /HERMES_GET_PAGE_CONTEXT/, 'bundle must contain the page collector');
  assert.match(bundle, /runStartupReadiness/, 'bundle must contain panel startup code');
  assert.doesNotMatch(bundle, /^\s*(?:import|export)\s/m, 'manifest content script must be classic');
  assert.doesNotMatch(bundle, /\bimport\s*\(/, 'lazy panel code must not create a runtime module request');

  const siblingChunks = fs.readdirSync(safariDist)
    .filter((name) => /^safari-content\.bundle-.+\.js$/.test(name));
  assert.deepEqual(siblingChunks, [], 'panel code must not be split into network-loaded chunks');
});

test('Safari direct-panel assets are web-accessible without exposing its old iframe document', () => {
  const manifestPath = path.join(safariDist, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    execFileSync(process.execPath, ['scripts/build-safari.mjs'], { cwd: root, encoding: 'utf8' });
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const resources = (manifest.web_accessible_resources || [])
    .flatMap((entry) => entry.resources || []);

  assert.ok(resources.includes('assets/fonts/JetBrainsMono-Regular.woff2'));
  assert.ok(resources.includes('assets/img/hermes-badge.webp'));
  assert.ok(resources.includes('assets/img/hermes-browser-mark.svg'));
  assert.equal(resources.includes('sidepanel.html'), false);
});
