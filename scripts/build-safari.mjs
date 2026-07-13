/**
 * Safari build script for Hermes Browser Extension.
 *
 * Copies the extension source to dist/safari/ and generates a Safari-compatible
 * manifest.json.
 *
 * Safari supports NEITHER sidebar API:
 *   - chrome.sidePanel   is Chromium-only
 *   - sidebar_action     is Firefox-only
 * (Confirmed against mdn/browser-compat-data: both report version_added: false
 * for Safari.)
 *
 * The Safari build strips both. On normal web pages the action opens a persistent
 * in-page Shadow DOM host; restricted pages fall back to a detached narrow
 * window via windows.create({ type: 'popup' }). A popover is deliberately not
 * used because it closes as soon as the user clicks the page.
 *
 * The resulting dist/safari/ is fed to `xcrun safari-web-extension-converter`
 * to produce the Xcode app wrapper. See SAFARI.md.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const src = path.join(root, 'extension');
const dest = path.join(root, 'dist', 'safari');
const buildInfoFileName = 'build-info.json';
const safariContentEntryFileName = 'safari-content-entry.js';
const safariContentBundleFileName = 'safari-content.bundle.js';

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (entry.name === buildInfoFileName) continue;
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function buildInfo() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commit = gitOutput(['rev-parse', 'HEAD']);
  const branch = gitOutput(['branch', '--show-current']);
  const status = gitOutput(['status', '--short', '--untracked-files=no']);
  return {
    name: packageJson.name,
    version: packageJson.version,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : '',
    branch,
    dirty: Boolean(status),
    builtAt: new Date().toISOString(),
    repository: packageJson.repository?.url || '',
    target: 'safari',
  };
}

const sourceManifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));

const contentScriptEntries = sourceManifest.content_scripts || [];
if (
  contentScriptEntries.length !== 1
  || contentScriptEntries[0]?.js?.length !== 1
  || contentScriptEntries[0].js[0] !== 'content.js'
) {
  throw new Error(
    'Safari bundling expects one manifest content script named content.js; '
    + 'import any additional Safari content modules from safari-content-entry.js.',
  );
}

// Safari's manifest content-script declaration has no module `type`. Apple
// documents module support for background workers, but injected scripts remain
// an ordered list of classic .js files. Emit one self-contained IIFE so neither
// static imports nor a dynamic-import chunk cross that boundary at runtime.
contentScriptEntries[0].js = [safariContentBundleFileName];

// --- Strip keys Safari does not implement -----------------------------------
// Safari logs a console warning and, for some keys, refuses to load the
// extension outright when it encounters unknown manifest keys/permissions.
delete sourceManifest.side_panel;            // Chromium-only
delete sourceManifest.sidebar_action;        // Firefox-only
delete sourceManifest.minimum_chrome_version; // meaningless on Safari

if (Array.isArray(sourceManifest.permissions)) {
  sourceManifest.permissions = sourceManifest.permissions.filter((p) => p !== 'sidePanel');
}

// _execute_sidebar_action is a Firefox-reserved command; Safari rejects it.
if (sourceManifest.commands && sourceManifest.commands._execute_sidebar_action) {
  delete sourceManifest.commands._execute_sidebar_action;
}

// Safari has no `audioCapture` permission — it grants the microphone per-origin
// in response to getUserMedia(). ensureExtensionAudioPermission() short-circuits
// on Safari (see voice-dictation.js), so declaring it here would only produce a
// converter warning for a permission we never request.
if (Array.isArray(sourceManifest.optional_permissions)) {
  sourceManifest.optional_permissions = sourceManifest.optional_permissions.filter((p) => p !== 'audioCapture');
  if (sourceManifest.optional_permissions.length === 0) delete sourceManifest.optional_permissions;
}

// --- Safari-specific additions ----------------------------------------------
// Safari 16.4+ is the MV3 / non-persistent-service-worker baseline.
sourceManifest.browser_specific_settings = {
  ...(sourceManifest.browser_specific_settings || {}),
  safari: {
    strict_min_version: '16.4',
  },
};

// The direct Shadow DOM panel resolves its fonts and images through
// runtime.getURL(). Those page-visible requests must be web-accessible, while
// sidepanel.html itself no longer needs to be exposed as an iframe document.
const directPanelSources = [
  fs.readFileSync(path.join(src, 'sidepanel.html'), 'utf8'),
  fs.readFileSync(path.join(src, 'sidepanel.css'), 'utf8'),
];
const directPanelAssets = Array.from(new Set(
  directPanelSources.flatMap((source) => source.match(/assets\/[a-zA-Z0-9_./-]+/g) || []),
)).sort();
for (const resource of directPanelAssets) {
  if (!fs.existsSync(path.join(src, resource))) {
    throw new Error(`Direct panel asset does not exist: ${resource}`);
  }
}
sourceManifest.web_accessible_resources = [{
  resources: directPanelAssets,
  matches: ['http://*/*', 'https://*/*'],
}];

const infoJson = `${JSON.stringify(buildInfo(), null, 2)}\n`;

fs.rmSync(dest, { recursive: true, force: true });
copyDir(src, dest);

await build({
  entryPoints: [path.join(src, safariContentEntryFileName)],
  outfile: path.join(dest, safariContentBundleFileName),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari16.4'],
  charset: 'ascii',
  legalComments: 'none',
  sourcemap: false,
  splitting: false,
  loader: {
    '.css': 'text',
    '.html': 'text',
  },
});

// The source entry contains ESM syntax by design; only its generated classic
// bundle belongs in the Safari extension payload.
fs.rmSync(path.join(dest, safariContentEntryFileName), { force: true });

fs.writeFileSync(path.join(dest, 'manifest.json'), `${JSON.stringify(sourceManifest, null, 2)}\n`);
fs.writeFileSync(path.join(dest, buildInfoFileName), infoJson);

console.log(`Built Safari extension: ${dest}`);
console.log('Safari manifest: stripped side_panel, sidebar_action, sidePanel permission,');
console.log('                 minimum_chrome_version, _execute_sidebar_action command');
console.log('                 added browser_specific_settings.safari.strict_min_version');
console.log(`Bundled direct Shadow DOM panel: ${safariContentBundleFileName}`);
console.log(`Stamped build metadata: ${buildInfoFileName}`);
console.log('');
console.log('Next: xcrun safari-web-extension-converter dist/safari --macos-only --project-location build/safari');
