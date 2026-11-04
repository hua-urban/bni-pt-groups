'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '..', '.github', 'scripts', 'sync-roster.js');

const runner = String.raw`
const realSetTimeout = global.setTimeout;
global.setTimeout = (callback, delay, ...args) =>
  realSetTimeout(callback, [3000, 8000, 20000].includes(delay) ? 0 : delay, ...args);
let attempts = 0;
global.fetch = async () => {
  attempts += 1;
  return { ok: true, status: 200, json: async () => JSON.parse(process.env.TEST_RESPONSE) };
};
process.on('exit', () => process.stdout.write('TEST_ATTEMPTS=' + attempts + '\n'));
require(process.argv[1]);
`;

function member(id, chains = ['A']) {
  return {
    id,
    memberId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    memberNo: String(id).padStart(3, '0'),
    name: `Fixture ${id}`,
    profession: 'Fixture profession',
    role: '',
    chains,
    aliases: [`Fixture ${id}`, `Fixture Alias ${id}`],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function liveRoster(count, overrides = {}) {
  return {
    ok: true,
    schemaVersion: 2,
    rosterVersion: 7,
    effectiveAsOf: '2026-01-01',
    contentHash: 'fixture-hash',
    members: Array.from({ length: count }, (_, i) => member(i + 1)),
    groups: [{ code: 'A', name: 'Fixture A', leader: 'Fixture', schedule: '', internalNote: 'x' }],
    ...overrides,
  };
}

function runSync({ response, previous, env = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sync-'));
  const output = path.join(dir, 'data.json');
  if (previous !== undefined) fs.writeFileSync(output, previous);
  const result = spawnSync(process.execPath, ['-e', runner, scriptPath], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      GAS_URL: 'https://fixture.invalid/exec',
      ROSTER_OUTPUT_PATH: output,
      TEST_RESPONSE: JSON.stringify(response),
      ALLOW_HEADCOUNT_DROP: '',
      ...env,
    },
  });
  assert.ifError(result.error);
  const written = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, written };
}

const previous55 = JSON.stringify({ members: Array.from({ length: 55 }, (_, i) => ({ id: i + 1 })), groups: [] });

test('the snapshot keeps only the fields the page renders', () => {
  const result = runSync({ response: liveRoster(55), previous: previous55 });

  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.written);
  assert.deepEqual(Object.keys(snapshot), ['members', 'groups', 'schemaVersion', 'rosterVersion', 'effectiveAsOf', 'contentHash']);
  assert.deepEqual(snapshot.members[0], { id: 1, name: 'Fixture 1', profession: 'Fixture profession', chains: ['A'] });
  assert.ok(snapshot.members.every((m) => Object.keys(m).join() === 'id,name,profession,chains'));
  assert.deepEqual(snapshot.groups, [{ code: 'A', name: 'Fixture A', leader: 'Fixture', schedule: '' }]);
  assert.doesNotMatch(result.written, /memberId|aliases|memberNo|updatedAt|internalNote/);
});

test('a headcount below 80% of the current snapshot is refused and the file is left alone', () => {
  const result = runSync({ response: liveRoster(40), previous: previous55 });

  assert.equal(result.status, 1);
  assert.equal(result.written, previous55);
  assert.match(result.stderr, /40.*55/);
  assert.match(result.stdout, /TEST_ATTEMPTS=4/);
});

test('a small headcount change is written normally', () => {
  const result = runSync({ response: liveRoster(50), previous: previous55 });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.written).members.length, 50);
});

test('a maintainer can accept a large drop explicitly', () => {
  const result = runSync({ response: liveRoster(40), previous: previous55, env: { ALLOW_HEADCOUNT_DROP: 'true' } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.written).members.length, 40);
});

test('a first run without a snapshot is written', () => {
  const result = runSync({ response: liveRoster(3) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.written).members.length, 3);
});

test('a response that is not schema 2 is refused', () => {
  for (const overrides of [{ schemaVersion: 1 }, { schemaVersion: undefined }, { rosterVersion: 'x' }]) {
    const result = runSync({ response: liveRoster(55, overrides), previous: previous55 });
    assert.equal(result.status, 1, JSON.stringify(overrides));
    assert.equal(result.written, previous55);
  }
});
