'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const pagePath = path.resolve(__dirname, '..', 'index.html');
const pageHtml = fs.readFileSync(pagePath, 'utf8');
const runtimeStart = pageHtml.indexOf('<script src="data.js');
assert.notEqual(runtimeStart, -1, 'the page should include its seed data before the app scripts');
const appScripts = [...pageHtml.slice(runtimeStart).matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]);
assert.equal(appScripts.length, 2, 'the tests should execute the page data loader and group editor scripts');

const CHAIN_ORDER = ['A', 'B', 'C', 'D', 'E'];
const FIXTURE_CODE = 'fixture-approved-editor-code';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRoster(version = 1, chains = ['A']) {
  return {
    ok: true,
    schemaVersion: 2,
    rosterVersion: version,
    effectiveAsOf: 'fixture-date',
    groups: CHAIN_ORDER.map((code) => ({ code, name: `Fixture ${code}`, leader: 'Fixture', schedule: '' })),
    members: [
      { id: 55, name: 'Fixture Member', profession: 'Fixture profession', chains },
      { id: 71, name: 'Second Fixture', profession: 'Fixture profession', chains: [] },
    ],
  };
}

function editorIdentity(code) {
  return {
    ok: true,
    label: `Fixture editor ${code}`,
    isAdmin: false,
    editableGroups: CHAIN_ORDER.slice(),
    rosterVersion: 1,
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => clone(body) };
}

class MockElement {
  constructor(id) {
    this.id = id;
    this.handlers = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.textContent = '';
    this.attributes = {};
    this._innerHTML = '';
    this.checkboxes = [];
    this.options = [];
    this.classList = {
      values: new Set(),
      add: (value) => this.classList.values.add(value),
      remove: (value) => this.classList.values.delete(value),
      toggle: (value, force) => {
        if (force === undefined) {
          if (this.classList.values.has(value)) this.classList.values.delete(value);
          else this.classList.values.add(value);
        } else if (force) this.classList.values.add(value);
        else this.classList.values.delete(value);
      },
    };
  }

  addEventListener(type, handler) {
    (this.handlers[type] ||= []).push(handler);
  }

  focus() {}

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (this.id === 'chainCheckboxes') {
      this.checkboxes = [...this._innerHTML.matchAll(/class="chain-cb" value="([^"]+)"( checked)?/g)]
        .map((match) => ({ value: match[1], checked: !!match[2], disabled: false }));
    }
    if (this.id === 'rosterSelect') {
      this.options = [...this._innerHTML.matchAll(/<option value="([^"]*)">/g)]
        .map((match) => match[1]);
      if (!this.options.includes(this.value)) this.value = this.options[0] || '';
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  querySelectorAll(selector) {
    if (this.id === 'chainCheckboxes' && selector === '.chain-cb:checked') {
      return this.checkboxes.filter((checkbox) => checkbox.checked);
    }
    if (this.id === 'chainCheckboxes' && selector === '.chain-cb') return this.checkboxes;
    return [];
  }
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function createHarness({ version = 1, initialChains = ['A'] } = {}) {
  const elements = new Map();
  const requests = [];
  let liveRoster = makeRoster(version, initialChains);
  let fetchBehavior;
  let uuid = 0;

  function getElement(id) {
    if (!elements.has(id)) elements.set(id, new MockElement(id));
    return elements.get(id);
  }

  async function defaultFetch(request) {
    if (request.url.startsWith('data.json')) return jsonResponse(liveRoster);
    if (request.body && request.body.action === 'whoami') {
      return request.body.code === 'fixture-rejected-code'
        ? jsonResponse({ ok: false, error: 'not authorized' })
        : jsonResponse(editorIdentity(request.body.code));
    }
    if (request.body && request.body.action === 'updateMember') {
      return jsonResponse({
        ok: true,
        id: request.body.id,
        name: 'Fixture Member',
        chains: request.body.chains,
        rosterVersion: liveRoster.rosterVersion,
        changed: false,
      });
    }
    if (request.method === 'GET' && request.url.startsWith('https://script.google.com/')) {
      return jsonResponse(liveRoster);
    }
    throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
  }

  fetchBehavior = defaultFetch;
  async function fetchMock(input, options = {}) {
    const body = options.body ? JSON.parse(options.body) : null;
    const request = {
      url: String(input),
      method: options.method || 'GET',
      options,
      body,
    };
    requests.push(request);
    return fetchBehavior(request);
  }

  const document = {
    body: getElement('body'),
    getElementById: getElement,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  getElement('guestPickerWrap').hidden = true;
  getElement('codeModalOverlay').hidden = true;
  getElement('memberModalOverlay').hidden = true;
  getElement('toast').hidden = true;
  getElement('manualGuestToggle').disabled = true;
  getElement('manualGuestToggle').hidden = true;
  getElement('editorIdentity').hidden = true;

  const context = vm.createContext({
    document,
    window: { PT_SEED: { groups: [], members: [] } },
    fetch: fetchMock,
    console: { error() {}, log() {} },
    crypto: { randomUUID: () => `fixture-request-${++uuid}` },
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  });

  appScripts.forEach((script) => vm.runInContext(script, context, { filename: pagePath }));
  await flushPromises();

  return {
    context,
    elements,
    requests,
    get liveRoster() { return liveRoster; },
    setRoster(roster) { liveRoster = clone(roster); },
    setFetchBehavior(handler) { fetchBehavior = handler; },
    async settle() { await flushPromises(); },
  };
}

function run(harness, expression) {
  return vm.runInContext(expression, harness.context, { filename: pagePath });
}

function setCheckedChains(harness, selected) {
  harness.elements.get('chainCheckboxes').checkboxes.forEach((checkbox) => {
    checkbox.checked = selected.includes(checkbox.value);
  });
}

function requestsFor(harness, action) {
  return harness.requests.filter((request) => request.body && request.body.action === action);
}

test('every entered edit code is server-validated before edit mode opens', async () => {
  const harness = await createHarness();
  harness.requests.length = 0;
  harness.elements.get('codeInput').value = 'fixture-legacy-approved-code';

  run(harness, 'submitCode()');
  await harness.settle();

  const whoami = requestsFor(harness, 'whoami');
  assert.equal(whoami.length, 1);
  assert.equal(whoami[0].method, 'POST');
  assert.deepEqual(whoami[0].body, { action: 'whoami', code: 'fixture-legacy-approved-code' });
  assert.equal(run(harness, 'editMode'), true);
  assert.match(harness.elements.get('editorIdentity').textContent, /Fixture editor/);
  assert.match(harness.elements.get('editorIdentity').textContent, /非 Google 登入身分/);

  run(harness, "openMemberModal(55, 'Fixture Member')");
  const boxes = harness.elements.get('chainCheckboxes').checkboxes;
  assert.deepEqual(boxes.map((checkbox) => checkbox.value), CHAIN_ORDER);
  assert.ok(boxes.every((checkbox) => checkbox.disabled === false), 'all five cross-group checkboxes stay enabled');
});

test('a rejected edit code never opens edit mode', async () => {
  const harness = await createHarness();
  harness.requests.length = 0;
  harness.elements.get('codeInput').value = 'fixture-rejected-code';

  run(harness, 'submitCode()');
  await harness.settle();

  assert.equal(run(harness, 'editMode'), false);
  assert.equal(requestsFor(harness, 'whoami').length, 1);
  assert.match(harness.elements.get('codeError').textContent, /未通過/);
  assert.equal(harness.requests.filter((request) => request.method === 'GET' && request.url.startsWith('https://script.google.com/')).length, 0);
});

test('editing is refused when the live schema 2 roster cannot be confirmed', async () => {
  const harness = await createHarness();
  harness.setFetchBehavior(async (request) => {
    if (request.body && request.body.action === 'whoami') return jsonResponse(editorIdentity(request.body.code));
    if (request.method === 'GET' && request.url.startsWith('https://script.google.com/')) {
      throw new Error('fixture offline');
    }
    if (request.url.startsWith('data.json')) return jsonResponse(makeRoster(1));
    throw new Error('Unexpected fixture request');
  });
  harness.requests.length = 0;
  harness.elements.get('codeInput').value = FIXTURE_CODE;

  run(harness, 'submitCode()');
  await harness.settle();

  assert.equal(run(harness, 'editMode'), false);
  assert.equal(run(harness, 'latestRosterAuthoritative'), false);
  assert.match(harness.elements.get('codeError').textContent, /最新名冊|最新資料/);
  assert.equal(harness.elements.get('loadStatus').textContent, '無法確認最新名冊，目前畫面僅供參考；暫停編輯。');
  assert.equal(requestsFor(harness, 'updateMember').length, 0);
});

test('save sends only updateMember with the live version, member number, all selected chains, and a request id', async () => {
  const harness = await createHarness({ version: 12, initialChains: ['A'] });
  harness.elements.get('codeInput').value = FIXTURE_CODE;
  run(harness, 'submitCode()');
  await harness.settle();
  harness.requests.length = 0;

  run(harness, "openMemberModal(55, 'Fixture Member')");
  setCheckedChains(harness, ['A', 'D']);
  run(harness, 'saveMember()');
  await harness.settle();

  const updates = requestsFor(harness, 'updateMember');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].body, {
    action: 'updateMember',
    code: FIXTURE_CODE,
    id: 55,
    chains: ['A', 'D'],
    expectedVersion: 12,
    requestId: 'group-edit-fixture-request-1',
  });
  assert.deepEqual(Object.keys(updates[0].body).sort(), ['action', 'chains', 'code', 'expectedVersion', 'id', 'requestId'].sort());
  assert.equal(harness.elements.get('memberModalOverlay').hidden, true);
});

test('an ambiguous network failure retries the same payload and request id', async () => {
  const harness = await createHarness({ version: 4, initialChains: ['A'] });
  let updateAttempts = 0;
  harness.setFetchBehavior(async (request) => {
    if (request.url.startsWith('data.json')) return jsonResponse(harness.liveRoster);
    if (request.body && request.body.action === 'whoami') return jsonResponse(editorIdentity(request.body.code));
    if (request.method === 'GET' && request.url.startsWith('https://script.google.com/')) return jsonResponse(harness.liveRoster);
    if (request.body && request.body.action === 'updateMember') {
      updateAttempts += 1;
      if (updateAttempts === 1) throw new Error('fixture connection dropped after send');
      harness.setRoster(makeRoster(5, ['B']));
      return jsonResponse({ ok: true, id: 55, name: 'Fixture Member', chains: request.body.chains, rosterVersion: 5, changed: true });
    }
    throw new Error('Unexpected fixture request');
  });

  harness.elements.get('codeInput').value = FIXTURE_CODE;
  run(harness, 'submitCode()');
  await harness.settle();
  harness.requests.length = 0;
  run(harness, "openMemberModal(55, 'Fixture Member')");
  setCheckedChains(harness, ['A', 'E']);

  run(harness, 'saveMember()');
  await harness.settle();
  const firstPayload = requestsFor(harness, 'updateMember')[0].body;
  assert.match(harness.elements.get('memberError').textContent, /相同請求編號/);
  assert.equal(run(harness, 'pendingSavePayload.requestId'), firstPayload.requestId);

  run(harness, 'saveMember()');
  await harness.settle();
  const payloads = requestsFor(harness, 'updateMember').map((request) => request.body);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[1], firstPayload);
  assert.equal(run(harness, 'pendingSavePayload'), null);
  assert.equal(run(harness, 'latestRosterVersion'), 5);
});

test('a tampered manual guest flow cannot submit a new member', async () => {
  const harness = await createHarness();
  harness.elements.get('codeInput').value = FIXTURE_CODE;
  run(harness, 'submitCode()');
  await harness.settle();
  harness.requests.length = 0;

  run(harness, 'openAddGuestModal()');
  harness.elements.get('manualGuestToggle').checked = true;
  run(harness, 'saveMember()');
  await harness.settle();

  assert.equal(requestsFor(harness, 'updateMember').length, 0);
  assert.match(harness.elements.get('memberError').textContent, /只能選擇中央名冊/);
  assert.equal(harness.elements.get('manualGuestToggle').hidden, true);
  assert.equal(harness.elements.get('manualGuestToggle').disabled, true);
});

test('a version conflict refreshes the roster and remains visible without a success toast', async () => {
  const harness = await createHarness({ version: 1, initialChains: ['A'] });
  harness.elements.get('codeInput').value = FIXTURE_CODE;
  run(harness, 'submitCode()');
  await harness.settle();

  harness.setFetchBehavior(async (request) => {
    if (request.body && request.body.action === 'updateMember') {
      harness.setRoster(makeRoster(2, ['B']));
      return jsonResponse({ ok: false, error: '名單已由其他人更新，請重新整理後再確認分組。' });
    }
    if (request.method === 'GET' && request.url.startsWith('https://script.google.com/')) return jsonResponse(harness.liveRoster);
    if (request.url.startsWith('data.json')) return jsonResponse(harness.liveRoster);
    if (request.body && request.body.action === 'whoami') return jsonResponse(editorIdentity(request.body.code));
    throw new Error('Unexpected fixture request');
  });

  run(harness, "openMemberModal(55, 'Fixture Member')");
  setCheckedChains(harness, ['C']);
  run(harness, 'saveMember()');
  await harness.settle();

  assert.equal(run(harness, 'latestRosterVersion'), 2);
  assert.equal(run(harness, 'latestRosterAuthoritative'), true);
  assert.equal(harness.elements.get('memberModalOverlay').hidden, false);
  assert.match(harness.elements.get('memberError').textContent, /版本衝突.*已更新至版本 2/);
  assert.deepEqual(harness.elements.get('chainCheckboxes').checkboxes.filter((box) => box.checked).map((box) => box.value), ['B']);
  assert.equal(harness.elements.get('toast').hidden, true);
});

test('obsolete membership redirect and snapshot/history/restore controls are absent', () => {
  assert.doesNotMatch(pageHtml, /stopImmediatePropagation|window\.location\.assign\([^)]*admin\/members/);
  assert.doesNotMatch(pageHtml, /id="(?:snapshotBtn|historyBtn|snapshotModalOverlay|historyModalOverlay|restoreConfirmOverlay)"/);
  assert.doesNotMatch(pageHtml, /action:\s*['"](?:snapshot|restore|addMember)['"]/);
  assert.match(pageHtml, /id="editToggleBtn"[^>]*>組長編輯模式</);
});
