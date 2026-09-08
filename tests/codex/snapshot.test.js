import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  ensurePreClaudexSnapshot,
  readSnapshotManifest,
  takeBackup,
  listBackups,
  pruneBackups
} from '../../src/codex/snapshot.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function mktemp(prefix = 'codexx-snap-test-') {
  const dir = path.join(os.tmpdir(), prefix + crypto.randomBytes(8).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    process.env[k] = overrides[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function fakeCodexHome(codexHome, files = {}) {
  await fsp.mkdir(codexHome, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(codexHome, name), content);
  }
}

// ===== ensurePreClaudexSnapshot =====

test('ensurePreClaudexSnapshot: takes snapshot of existing files', async () => {
  const codexHome = await mktemp('codex-home-');
  const claudexDir = await mktemp('claudex-dir-');
  await fakeCodexHome(codexHome, {
    'config.toml': 'model = "x"\n',
    'auth.json': '{"OPENAI_API_KEY":"sk"}\n',
    'AGENTS.md': '# project agents\n'
  });
  await withEnv({ CODEX_HOME: codexHome, CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    const r = await ensurePreClaudexSnapshot();
    assert.equal(r.taken, true);
    const manifest = await readSnapshotManifest();
    assert.equal(manifest.schema_version, 1);
    assert.ok(manifest.hashes.config_toml);
    assert.ok(manifest.hashes.auth_json);
    assert.ok(manifest.hashes.agents_md);
    // files copied
    const dir = path.join(claudexDir, 'codex-snapshot', 'pre-claudex');
    assert.equal((await fsp.readFile(path.join(dir, 'config.toml'), 'utf8')), 'model = "x"\n');
    assert.equal((await fsp.readFile(path.join(dir, 'auth.json'), 'utf8')), '{"OPENAI_API_KEY":"sk"}\n');
  });
});

test('ensurePreClaudexSnapshot: idempotent (taken=false on second call)', async () => {
  const codexHome = await mktemp('codex-home-');
  const claudexDir = await mktemp('claudex-dir-');
  await fakeCodexHome(codexHome, { 'config.toml': 'model = "x"\n' });
  await withEnv({ CODEX_HOME: codexHome, CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    const r1 = await ensurePreClaudexSnapshot();
    assert.equal(r1.taken, true);
    const r2 = await ensurePreClaudexSnapshot();
    assert.equal(r2.taken, false);
  });
});

test('ensurePreClaudexSnapshot: handles missing source files (nulls in manifest)', async () => {
  const codexHome = await mktemp('codex-home-');
  const claudexDir = await mktemp('claudex-dir-');
  // No files in codexHome
  await fakeCodexHome(codexHome, {});
  await withEnv({ CODEX_HOME: codexHome, CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    await ensurePreClaudexSnapshot();
    const manifest = await readSnapshotManifest();
    assert.equal(manifest.hashes.config_toml, null);
    assert.equal(manifest.hashes.auth_json, null);
    assert.equal(manifest.hashes.agents_md, null);
  });
});

test('ensurePreClaudexSnapshot: chmod 600 on auth.json', async () => {
  if (process.platform === 'win32') return;
  const codexHome = await mktemp('codex-home-');
  const claudexDir = await mktemp('claudex-dir-');
  await fakeCodexHome(codexHome, { 'auth.json': '{"OPENAI_API_KEY":"sk"}' });
  await withEnv({ CODEX_HOME: codexHome, CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    await ensurePreClaudexSnapshot();
    const snapAuth = path.join(claudexDir, 'codex-snapshot', 'pre-claudex', 'auth.json');
    const stat = await fsp.stat(snapAuth);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

// ===== takeBackup =====

test('takeBackup: copies current files with hashes + reason', async () => {
  const codexHome = await mktemp('codex-home-');
  const claudexDir = await mktemp('claudex-dir-');
  await fakeCodexHome(codexHome, {
    'config.toml': 'model = "x"\n',
    'auth.json': '{}\n'
  });
  await withEnv({ CODEX_HOME: codexHome, CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    const dir = await takeBackup('user-test-reason');
    assert.ok(dir.includes('codex-backups'));
    const reason = (await fsp.readFile(path.join(dir, 'reason.txt'), 'utf8')).trim();
    assert.equal(reason, 'user-test-reason');
    const hashes = JSON.parse(await fsp.readFile(path.join(dir, 'hashes.json'), 'utf8'));
    assert.ok(hashes.hashes.config_toml);
    assert.ok(hashes.hashes.auth_json);
  });
});

test('takeBackup: copies only files that exist', async () => {
  const codexHome = await mktemp('codex-home-');
  const claudexDir = await mktemp('claudex-dir-');
  await fakeCodexHome(codexHome, { 'config.toml': 'model = "x"\n' });
  await withEnv({ CODEX_HOME: codexHome, CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    const dir = await takeBackup('only-config');
    assert.ok(await fileExists(path.join(dir, 'config.toml')));
    assert.equal(await fileExists(path.join(dir, 'auth.json')), false);
  });
});

// ===== listBackups =====

test('listBackups: newest first', async () => {
  const codexHome = await mktemp('codex-home-');
  const claudexDir = await mktemp('claudex-dir-');
  await fakeCodexHome(codexHome, { 'config.toml': 'x' });
  await withEnv({ CODEX_HOME: codexHome, CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    // Insert backups with deterministic timestamps
    const root = path.join(claudexDir, 'codex-backups');
    await fsp.mkdir(path.join(root, '2026-01-01T10-00-00.000Z'), { recursive: true });
    await fsp.mkdir(path.join(root, '2026-05-01T10-00-00.000Z'), { recursive: true });
    await fsp.mkdir(path.join(root, '2025-12-01T10-00-00.000Z'), { recursive: true });
    const backups = await listBackups();
    assert.deepEqual(
      backups.map((b) => b.id),
      ['2026-05-01T10-00-00.000Z', '2026-01-01T10-00-00.000Z', '2025-12-01T10-00-00.000Z']
    );
  });
});

test('listBackups: empty when dir missing', async () => {
  const claudexDir = await mktemp('claudex-dir-');
  await withEnv({ CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    assert.deepEqual(await listBackups(), []);
  });
});

test('listBackups: flags complete vs incomplete (hashes.json missing) but lists both', async () => {
  const codexHome = await mktemp('codex-home-');
  const claudexDir = await mktemp('claudex-dir-');
  await fakeCodexHome(codexHome, { 'config.toml': 'model = "x"\n' });
  await withEnv({ CODEX_HOME: codexHome, CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    const completeDir = await takeBackup('full');
    // Simulate takeBackup interrupted right after ensureDir
    const root = path.join(claudexDir, 'codex-backups');
    await fsp.mkdir(path.join(root, '2099-01-01T00-00-00.000Z'), { recursive: true });
    const backups = await listBackups();
    assert.equal(backups.length, 2, 'incomplete dir must still be listed (pruneBackups needs it)');
    assert.equal(backups[0].id, '2099-01-01T00-00-00.000Z');
    assert.equal(backups[0].complete, false);
    assert.equal(backups[1].dir, completeDir);
    assert.equal(backups[1].complete, true);
  });
});

// ===== pruneBackups =====

test('pruneBackups: keeps recent N and recent-by-days', async () => {
  const claudexDir = await mktemp('claudex-dir-');
  await withEnv({ CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    const root = path.join(claudexDir, 'codex-backups');
    const stamps = [
      '2026-05-17T10-00-00.000Z', // very recent
      '2026-05-16T10-00-00.000Z',
      '2026-05-15T10-00-00.000Z',
      '2026-05-14T10-00-00.000Z',
      '2026-05-13T10-00-00.000Z',
      '2026-05-12T10-00-00.000Z',
      '2026-04-01T10-00-00.000Z', // old
      '2026-03-01T10-00-00.000Z',
      '2026-01-01T10-00-00.000Z'
    ];
    for (const s of stamps) await fsp.mkdir(path.join(root, s), { recursive: true });

    const result = await pruneBackups({
      keepCount: 5,
      keepDays: 7,
      now: new Date('2026-05-18T10:00:00Z')
    });
    // 5 most recent (count) + within last 7 days from 2026-05-18 (i.e. >= 2026-05-11)
    // So all entries from 2026-05-12..17 satisfy time, but ALSO entries 6+ outside count
    // 2026-05-12 is within 7 days (6 days back) -> kept by time
    // 2026-04-01 is outside both -> removed
    // 2026-03-01 + 2026-01-01 removed
    assert.equal(result.removed, 3);
    const remaining = (await fsp.readdir(root)).sort().reverse();
    assert.deepEqual(remaining, stamps.slice(0, 6));
  });
});

test('pruneBackups: no-op when nothing exceeds retention', async () => {
  const claudexDir = await mktemp('claudex-dir-');
  await withEnv({ CLAUDEX_CONFIG_DIR: claudexDir }, async () => {
    const root = path.join(claudexDir, 'codex-backups');
    await fsp.mkdir(path.join(root, '2026-05-17T10-00-00.000Z'), { recursive: true });
    await fsp.mkdir(path.join(root, '2026-05-16T10-00-00.000Z'), { recursive: true });
    const result = await pruneBackups({
      keepCount: 5,
      keepDays: 7,
      now: new Date('2026-05-18T10:00:00Z')
    });
    assert.equal(result.removed, 0);
    assert.equal(result.kept, 2);
  });
});

async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
