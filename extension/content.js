/**
 * Wrapped in an IIFE so development reinjection cannot redeclare top-level
 * bindings. Production Safari uses this manifest content script only; dynamic
 * injection can reload the host page and is deliberately avoided.
 */
(() => {
const CONTENT_SCRIPT_VERSION = '2026-07-13-persistent-sidebar';
const previousListener = globalThis.__HERMES_BROWSER_CONTENT_LISTENER__;
if (previousListener) {
  try {
    chrome.runtime.onMessage.removeListener(previousListener);
  } catch (_error) {
    // The previous listener can belong to an invalidated extension context after reload.
  }
}
globalThis.__HERMES_BROWSER_CONTENT_LOADED__ = CONTENT_SCRIPT_VERSION;

const TEXT_LIMITS = {
  minimal: 4_000,
  normal: 12_000,
  full: 30_000,
};

const PICK_STYLE_ID = 'hermes-element-pick-style';
const OUTER_HTML_LIMIT = 4_000;
const PICK_TEXT_LIMIT = 2_000;
const ELEMENT_PICK_MESSAGES = Object.freeze({
  START: 'HERMES_START_ELEMENT_PICK',
  CANCEL: 'HERMES_CANCEL_ELEMENT_PICK',
  RESULT: 'HERMES_ELEMENT_PICK_RESULT',
  PICKING: 'HERMES_ELEMENT_PICKING',
  CANCELLED: 'HERMES_ELEMENT_PICK_CANCELLED',
});
let pickModeActive = false;
let highlightedElement = null;

function normalizeReadableWhitespace(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textOf(node) {
  return normalizeReadableWhitespace(node?.innerText || node?.textContent || '');
}

function textContentWithoutJunk(root) {
  if (!root) return '';
  const clone = root.cloneNode?.(true);
  if (!clone) return normalizeReadableWhitespace(root.textContent || '');
  clone.querySelectorAll?.('script, style, noscript, svg, canvas, template, iframe').forEach((node) => node.remove());
  return normalizeReadableWhitespace(clone.textContent || '');
}

function uniqueReadableLines(values = []) {
  const seen = new Set();
  const lines = [];
  for (const value of values) {
    for (const rawLine of normalizeReadableWhitespace(value).split('\n')) {
      const line = rawLine.trim();
      if (line.length < 2) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  return lines.join('\n');
}

function collectReadablePageText(doc = document, { minSemanticChars = 80 } = {}) {
  const root = doc?.body || doc?.documentElement;
  if (!root) return '';
  const innerText = normalizeReadableWhitespace(root.innerText || doc?.documentElement?.innerText || '');
  const semanticText = uniqueReadableLines(Array.from(doc.querySelectorAll?.('main, article, [role="main"], h1, h2, h3, h4, p, li, blockquote, figcaption, td, th, a[href], button, summary, [aria-label]') || []).map(textOf));
  const fallbackText = textContentWithoutJunk(root);
  if (semanticText.length >= Math.max(minSemanticChars, innerText.length * 1.2)) return semanticText;
  if (innerText) return innerText;
  if (semanticText) return semanticText;
  return fallbackText;
}

function clamp(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
}

function clampPickerText(value = '', max = PICK_TEXT_LIMIT) {
  return clamp(value, max);
}

function escapeCssIdent(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  if (typeof globalThis.CSS !== 'undefined' && typeof globalThis.CSS.escape === 'function') {
    return globalThis.CSS.escape(raw);
  }
  return raw.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function buildCssSelector(element) {
  if (!element || element.nodeType !== 1) return '';
  const parts = [];
  let node = element;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();
    let part = tag;
    if (node.id) {
      part = `${tag}#${escapeCssIdent(node.id)}`;
      parts.unshift(part);
      break;
    }
    const testId = node.getAttribute?.('data-testid') || node.getAttribute?.('data-test-id');
    if (testId) {
      part = `${tag}[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
      parts.unshift(part);
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(node) + 1;
        part = `${tag}:nth-of-type(${index})`;
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function captureElementSnapshot(element) {
  if (!element || element.nodeType !== 1) {
    return { ok: false, reason: 'not_an_element' };
  }
  const tag = element.tagName.toLowerCase();
  const rect = element.getBoundingClientRect?.();
  const attrs = {};
  for (const name of ['id', 'class', 'name', 'type', 'href', 'src', 'role', 'aria-label', 'aria-labelledby', 'data-testid', 'data-test-id']) {
    const value = element.getAttribute?.(name);
    if (value) attrs[name] = value.slice(0, 500);
  }
  const className = typeof element.className === 'string' ? element.className.trim().slice(0, 300) : '';
  const text = clampPickerText((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim());
  let outerHtml = '';
  try {
    outerHtml = clampPickerText(element.outerHTML || '', OUTER_HTML_LIMIT);
  } catch {
    outerHtml = '';
  }
  return {
    ok: true,
    tag,
    selector: buildCssSelector(element),
    text,
    outerHtml,
    className,
    attributes: attrs,
    boundingBox: rect
      ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
      : null,
    capturedAt: new Date().toISOString(),
  };
}

function redact(value) {
  return String(value || '')
    .replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[^\s'"`;&]+/gi, 'Bearer [REDACTED_BEARER]')
    .replace(new RegExp('\\bsk-[A-Za-z0-9_-]{12,}\\b', 'g'), '[REDACTED_SECRET]')
    .replace(/\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g, '[REDACTED_SECRET]')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_SECRET]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SECRET]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|password|passwd|secret|private[_-]?key)\b["'`]?\s*[:=]\s*["'`]?([^\s'"`;&]+)/gi, (_match, key) => `${key}=[REDACTED_SECRET]`);
}

function pageMeta() {
  const description = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || '';
  const language = document.documentElement?.lang || document.querySelector('meta[http-equiv="content-language"]')?.content || '';
  const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .slice(0, 25)
    .map((node) => ({ level: node.tagName.toLowerCase(), text: textOf(node).slice(0, 240) }))
    .filter((item) => item.text);
  const interactive = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"]'))
    .slice(0, 80)
    .map((node) => {
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute('role');
      const kind = role || tag;
      const label = node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('name') || node.getAttribute('placeholder') || '';
      const href = tag === 'a' ? node.href : '';
      const text = textOf(node) || label || href;
      return { kind, text: text.slice(0, 220), href };
    })
    .filter((item) => item.text || item.href)
    .slice(0, 40);
  const forms = Array.from(document.forms || [])
    .slice(0, 10)
    .map((form) => ({
      name: form.getAttribute('name') || form.getAttribute('aria-label') || '',
      action: form.action || '',
      method: form.method || 'get',
      fields: Array.from(form.elements || [])
        .slice(0, 30)
        .map((el) => ({
          tag: el.tagName?.toLowerCase?.() || '',
          type: el.getAttribute?.('type') || '',
          name: el.getAttribute?.('name') || '',
          label: el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || '',
        })),
    }));
  return { description, language, canonical, headings, interactive, forms };
}

function collectContext(options = {}) {
  const depth = options.depth || 'normal';
  const limit = TEXT_LIMITS[depth] || TEXT_LIMITS.normal;
  const selection = globalThis.getSelection?.().toString() || '';
  const text = collectReadablePageText(document);
  return {
    ok: true,
    title: document.title || '',
    url: location.href,
    selectedText: clamp(redact(selection), Math.min(limit, 8_000)),
    text: clamp(redact(text), limit),
    meta: pageMeta(),
    capturedAt: new Date().toISOString(),
  };
}

function findBalancedJson(source, token) {
  const tokenIndex = source.indexOf(token);
  if (tokenIndex < 0) return null;
  const start = source.indexOf('{', tokenIndex + token.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function youtubePlayerResponse() {
  const scripts = Array.from(document.scripts || []);
  for (const script of scripts) {
    const text = script.textContent || '';
    if (!text.includes('ytInitialPlayerResponse')) continue;
    const json = findBalancedJson(text, 'ytInitialPlayerResponse');
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch (_error) {
      // Try next script.
    }
  }
  return null;
}

function captionTracks() {
  const response = youtubePlayerResponse();
  return response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
}

function pickCaptionTrack(tracks = []) {
  if (!tracks.length) return null;
  return tracks.find((track) => track.languageCode === 'en' && track.kind !== 'asr')
    || tracks.find((track) => track.languageCode === 'en')
    || tracks.find((track) => track.kind !== 'asr')
    || tracks[0];
}

function parseTimedTextXml(xml = '') {
  const doc = new DOMParser().parseFromString(String(xml || ''), 'text/xml');
  return Array.from(doc.querySelectorAll('text'))
    .map((node) => ({
      start: Number(node.getAttribute('start') || 0),
      duration: Number(node.getAttribute('dur') || 0),
      text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((segment) => segment.text);
}

async function collectYoutubeTranscript() {
  const tracks = captionTracks();
  const track = pickCaptionTrack(tracks);
  if (!track?.baseUrl) return { ok: false, reason: 'no_caption_tracks', source: 'page-dom' };
  const url = new URL(track.baseUrl);
  if (!url.searchParams.has('fmt')) url.searchParams.set('fmt', 'srv3');
  const requestOptions = { credentials: 'omit' };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    requestOptions.signal = AbortSignal.timeout(8_000);
  }
  const response = await fetch(url.toString(), requestOptions);
  if (!response.ok) return { ok: false, reason: `caption_fetch_${response.status}`, source: 'page-dom' };
  const segments = parseTimedTextXml(await response.text());
  if (!segments.length) return { ok: false, reason: 'empty_caption_track', source: 'page-dom' };
  return {
    ok: true,
    source: 'page-dom',
    language: track.languageCode || '',
    text: segments.map((segment) => segment.text).join('\n'),
    segments,
  };
}

function ensurePickStyles() {
  if (document.getElementById(PICK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PICK_STYLE_ID;
  style.textContent = `
    .hermes-element-pick-highlight {
      outline: 2px solid #e11d48 !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
    }
    html.hermes-element-pick-mode, html.hermes-element-pick-mode * {
      cursor: crosshair !important;
    }
    html.hermes-element-pick-mode::before {
      content: 'Hermes: click an element (Esc to cancel)';
      position: fixed;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483646;
      background: rgba(15, 23, 42, 0.92);
      color: #f8fafc;
      padding: 8px 14px;
      border-radius: 8px;
      font: 13px/1.4 system-ui, sans-serif;
      pointer-events: none;
      box-shadow: 0 4px 20px rgba(0,0,0,0.35);
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function clearHighlight() {
  if (highlightedElement) {
    highlightedElement.classList.remove('hermes-element-pick-highlight');
    highlightedElement = null;
  }
}

function setHighlight(element) {
  if (!element || element === highlightedElement) return;
  clearHighlight();
  highlightedElement = element;
  highlightedElement.classList.add('hermes-element-pick-highlight');
}

function teardownPickMode({ cancelled = false, pickedElement = null } = {}) {
  if (!pickModeActive) return;
  pickModeActive = false;
  clearHighlight();
  document.documentElement.classList.remove('hermes-element-pick-mode');
  document.removeEventListener('mousemove', onPickMouseMove, true);
  document.removeEventListener('click', onPickClick, true);
  document.removeEventListener('keydown', onPickKeydown, true);
  if (cancelled) {
    chrome.runtime.sendMessage({
      type: ELEMENT_PICK_MESSAGES.CANCELLED,
      url: location.href,
    }).catch(() => {});
  } else if (pickedElement) {
    chrome.runtime.sendMessage({
      type: ELEMENT_PICK_MESSAGES.RESULT,
      url: location.href,
      pickedElement,
    }).catch(() => {});
  }
}

function elementUnderPointer(event) {
  let target = document.elementFromPoint(event.clientX, event.clientY);
  while (target?.shadowRoot) {
    const inner = target.shadowRoot.elementFromPoint(event.clientX, event.clientY);
    if (!inner || inner === target) break;
    target = inner;
  }
  if (!target || target === document.documentElement || target === document.body) return null;
  if (target.id === PICK_STYLE_ID) return null;
  return target;
}

function onPickMouseMove(event) {
  if (!pickModeActive) return;
  const element = elementUnderPointer(event);
  if (element) setHighlight(element);
}

function onPickClick(event) {
  if (!pickModeActive) return;
  event.preventDefault();
  event.stopPropagation();
  const element = elementUnderPointer(event) || highlightedElement;
  if (!element) return;
  const snapshot = captureElementSnapshot(element);
  if (!snapshot.ok) return;
  teardownPickMode({ pickedElement: snapshot });
}

function onPickKeydown(event) {
  if (!pickModeActive) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    teardownPickMode({ cancelled: true });
  }
}

function startPickMode() {
  if (pickModeActive) return { ok: true, alreadyActive: true };
  pickModeActive = true;
  ensurePickStyles();
  document.documentElement.classList.add('hermes-element-pick-mode');
  document.addEventListener('mousemove', onPickMouseMove, true);
  document.addEventListener('click', onPickClick, true);
  document.addEventListener('keydown', onPickKeydown, true);
  chrome.runtime.sendMessage({ type: ELEMENT_PICK_MESSAGES.PICKING, url: location.href }).catch(() => {});
  return { ok: true };
}

function cancelPickMode() {
  teardownPickMode({ cancelled: true });
  return { ok: true };
}

// --- Injected sidebar -------------------------------------------------------
// Safari has no sidebar API, so mount Hermes inside a Shadow DOM host pinned to
// the right edge of the page. The Safari bundle supplies direct panel assets;
// unbundled development copies retain the older extension-document fallback.
// The host follows the durable off-canvas pattern used by Safari userscript
// sidebars: it stays mounted and an open class controls the slide animation.
// Mirrors extension/lib/injected-sidebar.mjs; this classic script cannot import it.
const SIDEBAR_MESSAGES = Object.freeze({
  TOGGLE: 'HERMES_TOGGLE_SIDEBAR',
  ENSURE: 'HERMES_ENSURE_SIDEBAR',
  READY: 'HERMES_SIDEBAR_READY',
  CLOSE: 'HERMES_SIDEBAR_CLOSE',
  CLOSED: 'HERMES_SIDEBAR_CLOSED',
});
const SIDEBAR_HOST_ID = 'hermes-browser-sidebar-host';
const SIDEBAR_OPEN_CLASS = 'hermes-sidebar-open';
const SIDEBAR_READY_TIMEOUT_MS = 2500;
const SIDEBAR_ANIMATION_MS = 300;
const DIRECT_PANEL_ASSETS_GLOBAL = '__HERMES_DIRECT_PANEL_ASSETS__';
const PANEL_MOUNT_GLOBAL = '__HERMES_BROWSER_PANEL_MOUNT__';
const SIDEBAR_WIDTH = Object.freeze({
  DEFAULT: 420,
  MIN: 320,
  MAX: 900,
  STORAGE_KEY: 'hermesBrowserSidebarWidth',
});

function clampSidebarWidth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return SIDEBAR_WIDTH.DEFAULT;
  return Math.min(SIDEBAR_WIDTH.MAX, Math.max(SIDEBAR_WIDTH.MIN, Math.round(numeric)));
}

function sidebarHost() {
  const connected = document.getElementById(SIDEBAR_HOST_ID);
  if (connected) return connected;
  const directHost = globalThis[PANEL_MOUNT_GLOBAL]?.host;
  return directHost?.ownerDocument === document ? directHost : null;
}

function sidebarIsOpen(host = sidebarHost()) {
  return Boolean(host?.classList.contains(SIDEBAR_OPEN_CLASS));
}

function setSidebarOpen(host, open) {
  if (!host) return false;
  if (!host.isConnected) (document.documentElement || document.body)?.appendChild(host);
  host.classList.toggle(SIDEBAR_OPEN_CLASS, open);
  host.setAttribute('aria-hidden', String(!open));
  return open;
}

function destroySidebar(host = sidebarHost()) {
  if (!host) return false;
  try {
    host.__hermesSidebarCleanup?.();
  } catch {
    /* best-effort */
  }
  host.remove();
  return true;
}

async function storedSidebarWidth() {
  try {
    const stored = await chrome.storage.local.get([SIDEBAR_WIDTH.STORAGE_KEY]);
    return clampSidebarWidth(stored?.[SIDEBAR_WIDTH.STORAGE_KEY]);
  } catch {
    return SIDEBAR_WIDTH.DEFAULT;
  }
}

function persistSidebarWidth(width) {
  // Width is cosmetic: never let a storage failure surface to the user or break
  // the sidebar. storage.local.set is async, so a synchronous try/catch alone
  // would let a rejection escape as an unhandled rejection — Safari rejects
  // these writes from page contexts more readily than Chromium does.
  try {
    const result = chrome.storage.local.set({ [SIDEBAR_WIDTH.STORAGE_KEY]: clampSidebarWidth(width) });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* best-effort */
  }
}

function directPanelAssets() {
  const assets = globalThis[DIRECT_PANEL_ASSETS_GLOBAL];
  if (!assets || typeof assets.html !== 'string' || typeof assets.css !== 'string' || typeof assets.load !== 'function') {
    return null;
  }
  return assets;
}

function directAssetUrl(path, assets) {
  const value = String(path || '').trim();
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return value;
  const clean = value.replace(/^\.\//, '');
  if (typeof assets.assetUrl === 'function') return assets.assetUrl(clean);
  return chrome.runtime.getURL(clean);
}

function resolveDirectPanelCss(css, assets) {
  return String(css || '')
    .replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (_match, _quote, path) => `url("${directAssetUrl(path, assets)}")`,
    )
    // Stylesheets in a ShadowRoot do not have an html/body/:root. Redirect
    // only those document selectors to the scoped facade elements.
    .replace(/:root\b/g, '.hermes-panel-root')
    .replace(/\bhtml(?=\[|,)/g, '.hermes-panel-root')
    .replace(/\bbody(?=\s*(?:,|\{))/g, '.hermes-panel-body');
}

function populateDirectPanelBody(panelBody, html, assets) {
  const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
  parsed.querySelectorAll('script, link[rel="stylesheet"], link[rel="icon"]').forEach((node) => node.remove());
  panelBody.innerHTML = parsed.body?.innerHTML || '';
  for (const node of panelBody.querySelectorAll('[src], [href]')) {
    for (const attribute of ['src', 'href']) {
      if (!node.hasAttribute(attribute)) continue;
      node.setAttribute(attribute, directAssetUrl(node.getAttribute(attribute), assets));
    }
  }
}

function createPanelSessionStorage() {
  const values = new Map();
  return {
    getItem(key) {
      const name = String(key);
      return values.has(name) ? values.get(name) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
    clear() {
      values.clear();
    },
  };
}

/**
 * Safari's real in-page path: the complete Hermes UI lives directly in this
 * ShadowRoot. No extension iframe, cross-frame WindowProxy, or READY handshake
 * participates in its lifecycle.
 */
function mountDirectSidebar(panelUrl, width, assets) {
  const host = document.createElement('div');
  host.id = SIDEBAR_HOST_ID;
  host.setAttribute('aria-label', 'Hermes Browser sidebar');
  host.setAttribute('aria-hidden', 'true');
  host.style.setProperty('width', `${clampSidebarWidth(width)}px`, 'important');

  // Hermes renders credentials and conversations. Keep the direct panel root
  // inaccessible to host-page JavaScript while retaining our scoped reference.
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial !important;
        position: fixed !important;
        inset: 0 0 0 auto !important;
        height: 100vh !important;
        max-width: 100vw !important;
        z-index: 2147483647 !important;
        border: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        color-scheme: normal !important;
        transform: translate3d(100%, 0, 0) !important;
        transition: transform ${SIDEBAR_ANIMATION_MS}ms cubic-bezier(.16, 1, .3, 1) !important;
        will-change: transform !important;
        pointer-events: none !important;
      }
      :host(.${SIDEBAR_OPEN_CLASS}) {
        transform: translate3d(0, 0, 0) !important;
        pointer-events: auto !important;
      }
      .hermes-sidebar-wrap { position:relative; width:100%; height:100%;
                             box-shadow:-2px 0 12px rgba(0,0,0,.18); background:#000; display:flex; }
      .hermes-sidebar-grip { position:absolute; left:0; top:0; width:8px; height:100%;
                             cursor:ew-resize; z-index:2147483647; background:transparent; }
      .hermes-sidebar-grip:hover { background:rgba(127,127,127,.35); }
      .hermes-sidebar-close { position:absolute; top:6px; left:12px; z-index:2147483647;
                              width:22px; height:22px; line-height:20px; text-align:center;
                              border-radius:6px; border:1px solid rgba(127,127,127,.4);
                              background:rgba(20,20,20,.75); color:#eee; cursor:pointer;
                              font:13px/20px -apple-system,system-ui,sans-serif; padding:0; }
      .hermes-sidebar-close:hover { background:rgba(60,60,60,.95); }
      .hermes-panel-surface { flex:1; width:100%; height:100%; min-width:0; overflow:hidden; }
    </style>
    <div class="hermes-sidebar-wrap">
      <div class="hermes-sidebar-grip" part="grip"></div>
      <button class="hermes-sidebar-close" title="Close Hermes" aria-label="Close Hermes">&times;</button>
      <div class="hermes-panel-surface"></div>
    </div>
  `;

  const surface = shadow.querySelector('.hermes-panel-surface');
  const grip = shadow.querySelector('.hermes-sidebar-grip');
  const closeButton = shadow.querySelector('.hermes-sidebar-close');
  const panelStyle = document.createElement('style');
  panelStyle.dataset.hermesPanelStyles = 'true';
  panelStyle.textContent = resolveDirectPanelCss(assets.css, assets);

  const panelDocumentElement = document.createElement('div');
  panelDocumentElement.className = 'hermes-panel-root';
  panelDocumentElement.lang = 'en';
  const panelBody = document.createElement('div');
  panelBody.className = 'hermes-panel-body';
  panelDocumentElement.appendChild(panelBody);
  surface.appendChild(panelDocumentElement);
  shadow.appendChild(panelStyle);
  populateDirectPanelBody(panelBody, assets.html, assets);

  globalThis[PANEL_MOUNT_GLOBAL] = {
    root: shadow,
    documentElement: panelDocumentElement,
    body: panelBody,
    host,
    locationSearch: (() => {
      try {
        return new URL(panelUrl).search;
      } catch {
        return '';
      }
    })(),
    sessionStorage: createPanelSessionStorage(),
  };

  closeButton.addEventListener('click', () => {
    setSidebarOpen(host, false);
    reportSidebarClosed();
  });

  grip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = host.getBoundingClientRect().width;
    surface.style.pointerEvents = 'none';
    const onMove = (moveEvent) => {
      const next = clampSidebarWidth(startWidth + (startX - moveEvent.clientX));
      host.style.setProperty('width', `${next}px`, 'important');
    };
    const onEnd = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onEnd);
      grip.removeEventListener('pointercancel', onEnd);
      surface.style.pointerEvents = '';
      persistSidebarWidth(host.getBoundingClientRect().width);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onEnd);
    grip.addEventListener('pointercancel', onEnd);
  });

  (document.documentElement || document.body).appendChild(host);
  const reveal = () => {
    if (host.isConnected) setSidebarOpen(host, true);
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(reveal));
  } else {
    setTimeout(reveal, 0);
  }
  storedSidebarWidth().then((storedWidth) => {
    if (host.isConnected) host.style.setProperty('width', `${storedWidth}px`, 'important');
  }).catch(() => {});

  Promise.resolve()
    .then(() => assets.load())
    .then(() => console.info('[Hermes Browser] mounted direct Shadow DOM sidebar'))
    .catch((error) => {
      console.error('[Hermes Browser] direct sidebar failed to start', error);
      panelBody.textContent = '';
      const failure = document.createElement('p');
      failure.setAttribute('role', 'alert');
      failure.style.cssText = 'margin:0;padding:48px 20px;color:#fff;background:#161616;font:14px/1.5 -apple-system,system-ui,sans-serif;';
      failure.textContent = `Hermes could not start: ${error?.message || String(error)}`;
      panelBody.appendChild(failure);
    });

  return { ok: true, mounted: true, direct: true };
}

/**
 * Mount the panel as an in-page sidebar and acknowledge it immediately.
 *
 * Safari can deliver extension-frame postMessage events through a different JS
 * world, which makes event.source identity unreliable. Waiting for READY before
 * answering the toolbar click caused a healthy, visible panel to be removed and
 * replaced by a window. READY is now diagnostic only; a missed handshake never
 * destroys a sidebar the user can already see.
 */
function mountSidebar(panelUrl, width = SIDEBAR_WIDTH.DEFAULT) {
  const assets = directPanelAssets();
  if (assets) return mountDirectSidebar(panelUrl, width, assets);

  const staleHost = sidebarHost();
  if (staleHost) destroySidebar(staleHost);

  const host = document.createElement('div');
  host.id = SIDEBAR_HOST_ID;
  host.setAttribute('aria-label', 'Hermes Browser sidebar');
  host.setAttribute('aria-hidden', 'true');
  host.style.setProperty('width', `${clampSidebarWidth(width)}px`, 'important');

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial !important;
        position: fixed !important;
        inset: 0 0 0 auto !important;
        height: 100vh !important;
        max-width: 100vw !important;
        z-index: 2147483647 !important;
        border: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        color-scheme: normal !important;
        transform: translate3d(100%, 0, 0) !important;
        transition: transform ${SIDEBAR_ANIMATION_MS}ms cubic-bezier(.16, 1, .3, 1) !important;
        will-change: transform !important;
        pointer-events: none !important;
      }
      :host(.${SIDEBAR_OPEN_CLASS}) {
        transform: translate3d(0, 0, 0) !important;
        pointer-events: auto !important;
      }
      .wrap { position:relative; width:100%; height:100%;
              box-shadow:-2px 0 12px rgba(0,0,0,.18); background:#000; display:flex; }
      .grip { position:absolute; left:0; top:0; width:8px; height:100%;
              cursor:ew-resize; z-index:2; background:transparent; }
      .grip:hover { background:rgba(127,127,127,.35); }
      .close { position:absolute; top:6px; left:12px; z-index:3;
               width:22px; height:22px; line-height:20px; text-align:center;
               border-radius:6px; border:1px solid rgba(127,127,127,.4);
               background:rgba(20,20,20,.75); color:#eee; cursor:pointer;
               font:13px/20px -apple-system,system-ui,sans-serif; padding:0; }
      .close:hover { background:rgba(60,60,60,.95); }
      iframe { flex:1; width:100%; height:100%; border:0; display:block; }
    </style>
    <div class="wrap">
      <div class="grip" part="grip"></div>
      <button class="close" title="Close Hermes" aria-label="Close Hermes">&times;</button>
      <iframe title="Hermes Browser" allow="clipboard-write; microphone"></iframe>
    </div>
  `;

  const iframe = shadow.querySelector('iframe');
  const grip = shadow.querySelector('.grip');
  const closeButton = shadow.querySelector('.close');
  let panelReady = false;

  const onPanelMessage = (event) => {
    const type = event.data?.type;
    if (type === SIDEBAR_MESSAGES.READY) {
      // READY only changes diagnostics. Accept it across Safari's isolated
      // WindowProxy wrappers; it cannot invoke a privileged operation.
      panelReady = true;
    }
    if (type === SIDEBAR_MESSAGES.CLOSE && event.source === iframe.contentWindow) {
      setSidebarOpen(host, false);
      reportSidebarClosed();
    }
  };
  window.addEventListener('message', onPanelMessage);

  // Keep the panel mounted off-canvas so reopening is instant and retains the
  // current conversation, just like direct-DOM Safari sidebars.
  closeButton.addEventListener('click', () => {
    setSidebarOpen(host, false);
    reportSidebarClosed();
  });

  // Drag-to-resize. Pointer capture keeps events coming while the cursor is
  // over the iframe, which would otherwise swallow them.
  grip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = host.getBoundingClientRect().width;
    iframe.style.pointerEvents = 'none';

    const onMove = (moveEvent) => {
      const next = clampSidebarWidth(startWidth + (startX - moveEvent.clientX));
      host.style.setProperty('width', `${next}px`, 'important');
    };
    const onEnd = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onEnd);
      grip.removeEventListener('pointercancel', onEnd);
      iframe.style.pointerEvents = '';
      persistSidebarWidth(host.getBoundingClientRect().width);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onEnd);
    grip.addEventListener('pointercancel', onEnd);
  });

  iframe.addEventListener('error', (event) => {
    console.warn('[Hermes Browser] sidebar iframe failed to load', panelUrl, event);
  });

  const readyTimer = setTimeout(() => {
    if (!panelReady) {
      console.warn(
        '[Hermes Browser] sidebar READY was not observed within %dms; keeping the mounted sidebar open.\n'
        + 'panel url: %s',
        SIDEBAR_READY_TIMEOUT_MS,
        panelUrl,
      );
    }
  }, SIDEBAR_READY_TIMEOUT_MS);

  host.__hermesSidebarCleanup = () => {
    clearTimeout(readyTimer);
    window.removeEventListener('message', onPanelMessage);
  };

  // documentElement, not body: body can be missing or replaced by the page.
  (document.documentElement || document.body).appendChild(host);
  iframe.src = panelUrl;
  console.info('[Hermes Browser] mounted persistent sidebar:', panelUrl);

  // Paint the off-canvas state before moving it to zero, producing the same
  // smooth entry used by direct-DOM sidebars.
  const reveal = () => {
    if (host.isConnected) setSidebarOpen(host, true);
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(reveal));
  } else {
    setTimeout(reveal, 0);
  }

  // Width is presentation-only. Read it after mounting so Safari never holds
  // the toolbar response channel open while storage wakes up.
  storedSidebarWidth().then((storedWidth) => {
    if (host.isConnected) host.style.setProperty('width', `${storedWidth}px`, 'important');
  }).catch(() => {});

  return { ok: true, mounted: true };
}

/** Tell the background the sidebar is gone, so it stops restoring it on navigation. */
function reportSidebarClosed() {
  try {
    const result = chrome.runtime.sendMessage({ type: SIDEBAR_MESSAGES.CLOSED });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* best-effort */
  }
}

function toggleSidebar(panelUrl) {
  const host = sidebarHost();
  if (host && sidebarIsOpen(host)) {
    setSidebarOpen(host, false);
    reportSidebarClosed();
    return { ok: true, mounted: false };
  }
  if (host) {
    setSidebarOpen(host, true);
    return { ok: true, mounted: true };
  }
  if (!panelUrl) return { ok: false, error: 'missing panel url' };
  return mountSidebar(panelUrl);
}

/** Mount if absent; a no-op if already there. Used to restore after a navigation. */
function ensureSidebar(panelUrl) {
  const host = sidebarHost();
  if (host) {
    setSidebarOpen(host, true);
    return { ok: true, mounted: true };
  }
  if (!panelUrl) return { ok: false, error: 'missing panel url' };
  return mountSidebar(panelUrl);
}

const messageListener = (message, _sender, sendResponse) => {
  // Answer "are you there?" so callers can skip chrome.scripting.executeScript.
  // On Safari that call reloads the page to inject, which would destroy an
  // injected sidebar living in that same page. See ensureContentScript().
  if (message?.type === 'HERMES_PING') {
    sendResponse({ ok: true, version: CONTENT_SCRIPT_VERSION });
    return true;
  }
  if (message?.type === SIDEBAR_MESSAGES.TOGGLE || message?.type === SIDEBAR_MESSAGES.ENSURE) {
    const run = message.type === SIDEBAR_MESSAGES.ENSURE ? ensureSidebar : toggleSidebar;
    try {
      sendResponse(run(message.url));
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return false;
  }
  if (message?.type === 'HERMES_GET_PAGE_CONTEXT') {
    try {
      sendResponse(collectContext(message.options || {}));
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  }
  if (message?.type === 'HERMES_GET_YOUTUBE_TRANSCRIPT_DOM') {
    collectYoutubeTranscript()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: error?.message || String(error), source: 'page-dom' }));
    return true;
  }
  if (message?.type === ELEMENT_PICK_MESSAGES.START) {
    try {
      sendResponse(startPickMode());
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  }
  if (message?.type === ELEMENT_PICK_MESSAGES.CANCEL) {
    try {
      sendResponse(cancelPickMode());
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  }
  return false;
};

chrome.runtime.onMessage.addListener(messageListener);
globalThis.__HERMES_BROWSER_CONTENT_LISTENER__ = messageListener;
})();
