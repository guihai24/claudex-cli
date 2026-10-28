import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  listProviders,
  readProvider,
  writeProvider,
  removeProviderFile,
  getCurrentProvider,
  setCurrentProvider,
  resolveProviderArg,
  providerExists
} from '../../src/codex/providers.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function mktemp(prefix = 'codexx-providers-test-') {
  const dir = path.join(os.tmpdir(), prefix + crypto.randomBytes(8).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

const VALID_PROVIDER = {
  name: 'openrouter',
  base_url: 'https://openrouter.ai/api/v1',
  api_key: 'sk-or-v1-FAKE',
  model: 'anthropic/claude-sonnet-4.5',
  wire_api: 'chat'
};

// ===== writeProvider validation =====

test('writeProvider: writes valid provider file with mode 0600', async () => {
  if (process.platform === 'win32') return;
  const dir = await mktemp();
  await writeProvider(VALID_PROVIDER, { dir });
  const file = path.join(dir, 'openrouter.json');
  const stat = await fsp.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('writeProvider: stamps schema_version and created_at', async () => {
  const dir = await mktemp();
  await writeProvider(VALID_PROVIDER, { dir });
  const back = await readProvider('openrouter', { dir });
  assert.equal(back.schema_version, 1);
  assert.ok(typeof back.created_at === 'string');
  assert.match(back.created_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('writeProvider: rejects invalid name', async () => {
  const dir = await mktemp();
  await assert.rejects(
    () => writeProvider({ ...VALID_PROVIDER, name: 'Foo' }, { dir }),
    /invalid provider name/
  );
});

test('writeProvider: rejects reserved name', async () => {
  const dir = await mktemp();
  await assert.rejects(
    () => writeProvider({ ...VALID_PROVIDER, name: 'openai' }, { dir }),
    /reserved/
  );
});

test('writeProvider: rejects claudex- prefix', async () => {
  const dir = await mktemp();
  await assert.rejects(
    () => writeProvider({ ...VALID_PROVIDER, name: 'claudex-foo' }, { dir }),
    /must not start/
  );
});

test('writeProvider: rejects bad base_url', async () => {
  const dir = await mktemp();
  await assert.rejects(
    () => writeProvider({ ...VALID_PROVIDER, base_url: 'ftp://x' }, { dir }),
    /http/
  );
  await assert.rejects(
    () => writeProvider({ ...VALID_PROVIDER, base_url: '' }, { dir }),
    /base_url/
  );
});

test('writeProvider: rejects missing api_key', async () => {
  const dir = await mktemp();
  await assert.rejects(
    () => writeProvider({ ...VALID_PROVIDER, api_key: '' }, { dir }),
    /api_key/
  );
});

test('writeProvider: rejects bad wire_api', async () => {
  const dir = await mktemp();
  await assert.rejects(
    () => writeProvider({ ...VALID_PROVIDER, wire_api: 'grpc' }, { dir }),
    /wire_api/
  );
});

test('writeProvider: rejects bad model_reasoning_effort', async () => {
  const dir = await mktemp();
  await assert.rejects(
    () => writeProvider({ ...VALID_PROVIDER, model_reasoning_effort: 'extreme' }, { dir }),
    /model_reasoning_effort/
  );
});

test('writeProvider: accepts an optional auto-review model', async () => {
  const dir = await mktemp();
  await writeProvider({ ...VALID_PROVIDER, auto_review_model: 'review-cheap' }, { dir });
  const back = await readProvider('openrouter', { dir });
  assert.equal(back.auto_review_model, 'review-cheap');
});

test('writeProvider: rejects an empty or non-string auto-review model', async () => {
  const dir = await mktemp();
  await assert.rejects(
    () => writeProvider({ ...VALID_PROVIDER, auto_review_model: '  ' }, { dir }),
    /auto_review_model/
  );
  await assert.rejects(
    () => writeProvider({ ...VALID_PROVIDER, auto_review_model: 42 }, { dir }),
    /auto_review_model/
  );
});

// ===== read / list / remove =====

test('readProvider: throws if missing', async () => {
  const dir = await mktemp();
  await assert.rejects(() => readProvider('nope', { dir }), /not found/);
});

test('readProvider: round-trips writeProvider', async () => {
  const dir = await mktemp();
  await writeProvider(VALID_PROVIDER, { dir });
  const back = await readProvider('openrouter', { dir });
  assert.equal(back.name, 'openrouter');
  assert.equal(back.base_url, VALID_PROVIDER.base_url);
  assert.equal(back.api_key, VALID_PROVIDER.api_key);
});

test('listProviders: empty dir → empty array', async () => {
  const dir = await mktemp();
  assert.deepEqual(await listProviders({ dir }), []);
});

test('listProviders: nonexistent dir → empty array', async () => {
  const dir = path.join(os.tmpdir(), `nope-${crypto.randomBytes(4).toString('hex')}`);
  assert.deepEqual(await listProviders({ dir }), []);
});

test('listProviders: returns sorted names of valid .json files only', async () => {
  const dir = await mktemp();
  await writeProvider({ ...VALID_PROVIDER, name: 'zebra' }, { dir });
  await writeProvider({ ...VALID_PROVIDER, name: 'alpha' }, { dir });
  await writeProvider({ ...VALID_PROVIDER, name: 'mango' }, { dir });
  // Drop in noise: invalid name + non-json file
  await fsp.writeFile(path.join(dir, 'README.md'), 'noise');
  await fsp.writeFile(path.join(dir, 'BadName.json'), '{}');
  const list = await listProviders({ dir });
  assert.deepEqual(list, ['alpha', 'mango', 'zebra']);
});

test('removeProviderFile: removes existing', async () => {
  const dir = await mktemp();
  await writeProvider(VALID_PROVIDER, { dir });
  assert.equal(await providerExists('openrouter', { dir }), true);
  const removed = await removeProviderFile('openrouter', { dir });
  assert.equal(removed, true);
  assert.equal(await providerExists('openrouter', { dir }), false);
});

test('removeProviderFile: returns false if not present', async () => {
  const dir = await mktemp();
  const removed = await removeProviderFile('ghost', { dir });
  assert.equal(removed, false);
});

// ===== getCurrentProvider / setCurrentProvider =====

test('getCurrentProvider: null when file missing', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'codex-current-provider');
  assert.equal(await getCurrentProvider({ file }), null);
});

test('setCurrentProvider + get: round-trip', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'codex-current-provider');
  await setCurrentProvider('openrouter', { file });
  assert.equal(await getCurrentProvider({ file }), 'openrouter');
});

test('setCurrentProvider: clears when called with null/empty', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'codex-current-provider');
  await setCurrentProvider('openrouter', { file });
  await setCurrentProvider(null, { file });
  assert.equal(await getCurrentProvider({ file }), null);
});

test('setCurrentProvider: chmod 600 on Unix', async () => {
  if (process.platform === 'win32') return;
  const dir = await mktemp();
  const file = path.join(dir, 'codex-current-provider');
  await setCurrentProvider('foo', { file });
  const stat = await fsp.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
});

// ===== resolveProviderArg =====

test('resolveProviderArg: resolves by exact name', async () => {
  const dir = await mktemp();
  await writeProvider({ ...VALID_PROVIDER, name: 'foo' }, { dir });
  await writeProvider({ ...VALID_PROVIDER, name: 'bar' }, { dir });
  assert.equal(await resolveProviderArg('foo', { dir }), 'foo');
});

test('resolveProviderArg: resolves by 1-based index', async () => {
  const dir = await mktemp();
  await writeProvider({ ...VALID_PROVIDER, name: 'zebra' }, { dir });
  await writeProvider({ ...VALID_PROVIDER, name: 'alpha' }, { dir });
  // sorted: alpha, zebra
  assert.equal(await resolveProviderArg('1', { dir }), 'alpha');
  assert.equal(await resolveProviderArg('2', { dir }), 'zebra');
});

test('resolveProviderArg: throws on unknown name', async () => {
  const dir = await mktemp();
  await writeProvider(VALID_PROVIDER, { dir });
  await assert.rejects(() => resolveProviderArg('ghost', { dir }), /not found/);
});

test('resolveProviderArg: throws on out-of-range index', async () => {
  const dir = await mktemp();
  await writeProvider(VALID_PROVIDER, { dir });
  await assert.rejects(() => resolveProviderArg('5', { dir }), /out of range/);
  await assert.rejects(() => resolveProviderArg('0', { dir }), /out of range/);
});

test('resolveProviderArg: throws on empty input', async () => {
  const dir = await mktemp();
  await assert.rejects(() => resolveProviderArg('', { dir }), /no provider/);
  await assert.rejects(() => resolveProviderArg(null, { dir }), /no provider/);
});
