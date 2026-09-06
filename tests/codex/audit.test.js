import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  appendAuditEvent,
  tailAuditLog,
  readLastKnownHashes,
  writeLastKnownHashes
} from '../../src/codex/audit.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function mktemp(prefix = 'codexx-audit-test-') {
  const dir = path.join(os.tmpdir(), prefix + crypto.randomBytes(8).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

test('tailAuditLog: missing file → empty array', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'audit.log');
  const events = await tailAuditLog(10, { path: file });
  assert.deepEqual(events, []);
});

test('appendAuditEvent + tailAuditLog: round-trip one event', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'audit.log');
  await appendAuditEvent(
    { action: 'use', from: 'a', to: 'b' },
    { path: file, ts: '2026-05-17T10:00:00Z', actor: 'codexx-test' }
  );
  const [ev] = await tailAuditLog(10, { path: file });
  assert.equal(ev.action, 'use');
  assert.equal(ev.from, 'a');
  assert.equal(ev.to, 'b');
  assert.equal(ev.ts, '2026-05-17T10:00:00Z');
  assert.equal(ev.actor, 'codexx-test');
});

test('appendAuditEvent: multiple appends preserve order', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'audit.log');
  for (let i = 0; i < 5; i++) {
    await appendAuditEvent({ action: 'use', n: i }, { path: file });
  }
  const events = await tailAuditLog(10, { path: file });
  assert.equal(events.length, 5);
  assert.deepEqual(events.map((e) => e.n), [0, 1, 2, 3, 4]);
});

test('tailAuditLog: respects n limit', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'audit.log');
  for (let i = 0; i < 10; i++) {
    await appendAuditEvent({ action: 'use', n: i }, { path: file });
  }
  const events = await tailAuditLog(3, { path: file });
  assert.deepEqual(events.map((e) => e.n), [7, 8, 9]);
});

test('tailAuditLog: malformed lines surface as {malformed: true}', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'audit.log');
  await appendAuditEvent({ action: 'ok' }, { path: file });
  await fsp.appendFile(file, '{ this is bad json\n');
  const events = await tailAuditLog(10, { path: file });
  assert.equal(events.length, 2);
  assert.equal(events[1].malformed, true);
  assert.ok(events[1].raw.includes('this is bad'));
});

test('readLastKnownHashes: missing file → null', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'hashes.json');
  assert.equal(await readLastKnownHashes({ path: file }), null);
});

test('writeLastKnownHashes + read: round-trip', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'hashes.json');
  await writeLastKnownHashes(
    {
      config_toml_hash: 'aaa',
      auth_json_hash: 'bbb',
      env_file_hash: 'eee',
      agents_md_hash: 'ccc',
      recorded_at: '2026-05-17T10:00:00Z'
    },
    { path: file }
  );
  const back = await readLastKnownHashes({ path: file });
  assert.equal(back.config_toml_hash, 'aaa');
  assert.equal(back.auth_json_hash, 'bbb');
  assert.equal(back.env_file_hash, 'eee');
  assert.equal(back.agents_md_hash, 'ccc');
  assert.equal(back.recorded_at, '2026-05-17T10:00:00Z');
  assert.equal(back.schema_version, 1);
});

test('writeLastKnownHashes: fills missing fields with null + default recorded_at', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'hashes.json');
  await writeLastKnownHashes({ config_toml_hash: 'h' }, { path: file });
  const back = await readLastKnownHashes({ path: file });
  assert.equal(back.config_toml_hash, 'h');
  assert.equal(back.auth_json_hash, null);
  assert.equal(back.env_file_hash, null);
  assert.equal(back.agents_md_hash, null);
  assert.ok(back.recorded_at);
});
