import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PANEL_MOUNT_GLOBAL,
  createPanelDocument,
  isDirectPanel,
  resolvePanelDocument,
  resolvePanelRuntime,
} from '../extension/lib/panel-document.mjs';

test('ordinary extension panels keep the native document', () => {
  const nativeDocument = { querySelector() {} };
  assert.equal(resolvePanelDocument({ document: nativeDocument }), nativeDocument);
  assert.equal(isDirectPanel({ document: nativeDocument }), false);
});

test('direct panels scope selectors and events to their ShadowRoot', () => {
  const calls = [];
  const created = { tagName: 'DIV' };
  const nativeDocument = {
    createElement(tagName) {
      calls.push(['create', tagName]);
      return created;
    },
  };
  const root = {
    querySelector(selector) {
      calls.push(['one', selector]);
      return 'one';
    },
    querySelectorAll(selector) {
      calls.push(['all', selector]);
      return ['all'];
    },
    getElementById(id) {
      calls.push(['id', id]);
      return 'id';
    },
    addEventListener(type) {
      calls.push(['on', type]);
    },
    removeEventListener(type) {
      calls.push(['off', type]);
    },
  };
  const documentElement = { dataset: {} };
  const body = { classList: {} };
  const mount = { root, documentElement, body };
  const panelDocument = createPanelDocument(nativeDocument, mount);

  assert.equal(panelDocument.querySelector('#promptInput'), 'one');
  assert.deepEqual(panelDocument.querySelectorAll('button'), ['all']);
  assert.equal(panelDocument.getElementById('messages'), 'id');
  assert.equal(panelDocument.createElement('div'), created);
  panelDocument.addEventListener('click', () => {});
  panelDocument.removeEventListener('click', () => {});
  assert.equal(panelDocument.documentElement, documentElement);
  assert.equal(panelDocument.body, body);
  assert.deepEqual(calls, [
    ['one', '#promptInput'],
    ['all', 'button'],
    ['id', 'messages'],
    ['create', 'div'],
    ['on', 'click'],
    ['off', 'click'],
  ]);
});

test('the configured mount is detected through the shared global key', () => {
  const sessionStorage = {};
  const root = {
    querySelector() {},
    querySelectorAll() {},
    getElementById() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const mount = { root, documentElement: {}, body: {}, locationSearch: '?panel=tab&tabId=42', sessionStorage };
  const globalObject = {
    document: { createElement() {} },
    location: { search: '?page=true' },
    sessionStorage: {},
    [PANEL_MOUNT_GLOBAL]: mount,
  };
  assert.equal(isDirectPanel(globalObject), true);
  assert.notEqual(resolvePanelDocument(globalObject), globalObject.document);
  assert.deepEqual(resolvePanelRuntime(globalObject), {
    locationSearch: '?panel=tab&tabId=42',
    sessionStorage,
    chrome: undefined,
    fetch: undefined,
    WebSocket: undefined,
    direct: true,
  });
});
