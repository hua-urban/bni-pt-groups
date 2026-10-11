'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '..', '.github', 'scripts', 'reconcile-roster.js');
const notificationTokenSentinel = 'test-only-notify-token';

const runner = String.raw`
const scriptPath = process.argv[1];
const realSetTimeout = global.setTimeout;
global.setTimeout = (callback, delay, ...args) =>
  realSetTimeout(callback, [3000, 8000, 20000].includes(delay) ? 0 : delay, ...args);

process.env.PT_GAS_URL = 'https://fixture.invalid/pt';
process.env.PORTAL_URL = 'https://fixture.invalid/portal';
process.env.TRAINING_URL = 'https://fixture.invalid/training';
process.env.ETEAM_URL = 'https://fixture.invalid/eteam';
process.env.NOTIFY_URL = 'https://fixture.invalid/notify';
process.env.NOTIFY_TOKEN = 'test-only-notify-token';

const failedEndpoint = process.env.TEST_FAIL_ENDPOINT;
const createMismatch = process.env.TEST_CREATE_MISMATCH === '1';
let failedAttempts = 0;
let notificationText = '';
const response = (body) => ({ ok: true, status: 200, text: async () => body });

global.fetch = async (input) => {
  const url = new URL(String(input));
  const endpoint = url.pathname.slice(1);
  if (endpoint === failedEndpoint) {
    failedAttempts += 1;
    throw new Error('The operation was aborted due to timeout');
  }
  if (endpoint === 'pt') {
    return response(JSON.stringify({ ok: true, members: [{ name: 'Demo' }] }));
  }
  if (endpoint === 'portal') {
    return response(createMismatch
      ? '<tr data-n="Demo"><tr data-n="Extra">'
      : '<tr data-n="Demo">');
  }
  if (endpoint === 'training') return response(JSON.stringify({ names: ['Demo'] }));
  if (endpoint === 'eteam') {
    return response('const BRANCH_ROSTER = [\n ["Demo", "專業", ["A"]]\n];');
  }
  if (endpoint === 'notify') {
    notificationText = url.searchParams.get('text') || '';
    return response(JSON.stringify({ ok: true, reason: 'sent' }));
  }
  throw new Error('Unexpected fixture endpoint');
};

process.on('beforeExit', () => {
  process.stdout.write(
    'TEST_EXIT=' + (process.exitCode ?? 0) +
    ' TEST_FAILED_ATTEMPTS=' + failedAttempts +
    ' TEST_NO_STALE_CACHE=' + notificationText.includes('本次未使用快取資料代替最新回應') +
    ' TEST_TOKEN_IN_MESSAGE=' + notificationText.includes(process.env.NOTIFY_TOKEN) + '\n'
  );
});

require(scriptPath);
`;

function runReconciliation(failingEndpoint, createMismatch = false) {
  const result = spawnSync(process.execPath, ['-e', runner, scriptPath], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      TEST_FAIL_ENDPOINT: failingEndpoint,
      TEST_CREATE_MISMATCH: createMismatch ? '1' : '0',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('an unavailable baseline sends a safe warning and fails the process', () => {
  const result = runReconciliation('pt');

  assert.match(result.stdout, /PowerTeam 組別管理：查不到/);
  assert.match(result.stdout, /連續 4 次失敗/);
  assert.match(result.stdout, /TEST_EXIT=1 TEST_FAILED_ATTEMPTS=4 TEST_NO_STALE_CACHE=true TEST_TOKEN_IN_MESSAGE=false/);
  assert.doesNotMatch(result.stdout, new RegExp(notificationTokenSentinel));
  assert.equal(result.status, 1, 'an unavailable baseline must not make the workflow green');
});

test('an unavailable secondary endpoint also fails an incomplete reconciliation', () => {
  const result = runReconciliation('portal');

  assert.match(result.stdout, /對外夥伴入口頁：查不到/);
  assert.match(result.stdout, /TEST_EXIT=1 TEST_FAILED_ATTEMPTS=4 TEST_NO_STALE_CACHE=false TEST_TOKEN_IN_MESSAGE=false/);
  assert.doesNotMatch(result.stdout, new RegExp(notificationTokenSentinel));
  assert.equal(result.status, 1, 'any failed endpoint leaves the reconciliation incomplete');
});

test('a completed reconciliation with a roster mismatch remains a normal completion', () => {
  const result = runReconciliation('', true);

  assert.match(result.stdout, /對外夥伴入口頁：2 人/);
  assert.match(result.stdout, /TEST_EXIT=0 TEST_FAILED_ATTEMPTS=0 TEST_NO_STALE_CACHE=false TEST_TOKEN_IN_MESSAGE=false/);
  assert.doesNotMatch(result.stdout, new RegExp(notificationTokenSentinel));
  assert.equal(result.status, 0, 'a mismatch is a completed check, not a failed fetch');
});
