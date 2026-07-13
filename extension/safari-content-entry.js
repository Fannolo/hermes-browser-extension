import panelHtml from './sidepanel.html';
import panelCss from './sidepanel.css';
import './content.js';

const DIRECT_PANEL_ASSETS_GLOBAL = '__HERMES_DIRECT_PANEL_ASSETS__';

function assetUrl(resourcePath = '') {
  const path = String(resourcePath || '').replace(/^\.\//, '');
  return chrome.runtime.getURL(path);
}

// Manifest content scripts are classic scripts in Safari. build-safari.mjs
// bundles this entry and the lazy import below into one IIFE, so opening the
// panel never asks the page to load an extension module or a secondary chunk.
globalThis[DIRECT_PANEL_ASSETS_GLOBAL] = Object.freeze({
  html: panelHtml,
  css: panelCss,
  assetUrl,
  load: () => import('./sidepanel.js'),
});
