import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { restoreBackup } from '../../src/codex/revert.js';
import { takeBackup, listBackups } from '../../src/codex/snapshot.js';
import { applyProviderSwitch } from '../../src/codex/apply-switch.js';
import { writeProvider } from '../../src/codex/providers.js';
import { inspectDrift } from '../../src/codex/reconcile.js';
import { readLastKnownHashes } from '../../src/codex/audit.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function mktemp(prefix = 'codexx-restore-test-') {
  const dir = path.join(os.tmpdir(), prefix + crypto.randomBytes(8).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

async function withIsolatedHome(fn) {
  const codexHome = await mktemp('codex-home-');
  const claudexDir = await mktemp('claudex-dir-');
  const saved = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDEX_CONFIG_DIR: process.env.CLAUDEX_CONFIG_DIR
  };
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDEX_CONFIG_DIR = claudexDir;
  try {
    return await fn({ codexHome, claudexDir });
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function seedLiveFiles(codexHome, tag) {
  await fsp.writeFile(path.join(codexHome, 'config.toml'), `model = "${tag}"\n`, { mode: 0o600 });
  await fsp.writeFile(path.join(codexHome, 'auth.json'), `{"OPENAI_API_KEY":"${tag}"}\n`, { mode: 0o600 });
  await fsp.writeFile(path.join(codexHome, '.env'), `OPENAI_API_KEY=${tag}\n`, { mode: 0o600 });
}

async function liveState(codexHome) {
  const out = {};
  for (const f of ['config.toml', 'auth.json', '.env']) {
    const p = path.join(codexHome, f);
    out[f] = fs.existsSync(p) ? await fsp.readFile(p, 'utf8') : null;
  }
  return out;
}

const PROVIDER = {
  name: 'openrouter',
  base_url: 'https://openrouter.ai/api/v1',
  api_key: 'sk-or-FAKE',
  model: 'anthropic/claude-sonnet-4.5',
  wire_api: 'chat'
};

// ===== restoreBackup: the happy path =====

test('restoreBackup: restores all three files from a complete backup', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await seedLiveFiles(codexHome, 'v1');
    await takeBackup('snapshot v1');
    await seedLiveFiles(codexHome, 'v2');

    const r = await restoreBackup('latest', { appendAudit: false });
    assert.deepEqual(r.restored, { config_toml: true, auth_json: true, env_file: true });
    assert.deepEqual(r.deleted, { config_toml: false, auth_json: false, env_file: false });
    const live = await liveState(codexHome);
    assert.equal(live['config.toml'], 'model = "v1"\n');
    assert.equal(live['auth.json'], '{"OPENAI_API_KEY":"v1"}\n');
    assert.equal(live['.env'], 'OPENAI_API_KEY=v1\n');
  });
});

test('restoreBackup: config.toml keeps 0600 after restore', async () => {
  if (process.platform === 'win32') return;
  await withIsolatedHome(async ({ codexHome }) => {
    await seedLiveFiles(codexHome, 'v1');
    await takeBackup('v1');
    await restoreBackup('latest', { appendAudit: false });
    const stat = await fsp.stat(path.join(codexHome, 'config.toml'));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

// ===== restoreBackup: data-loss guards =====

test('restoreBackup: refuses an incomplete backup dir as latest (interrupted takeBackup)', async () => {
  await withIsolatedHome(async ({ codexHome, claudexDir }) => {
    await seedLiveFiles(codexHome, 'live');
    // Only an EMPTY dir exists — exactly what a Ctrl-C between ensureDir and
    // the file copies leaves behind. Old code restored from it and unlinked
    // all three live files.
    await fsp.mkdir(path.join(claudexDir, 'codex-backups', '2099-01-01T00-00-00.000Z'), { recursive: true });

    await assert.rejects(
      () => restoreBackup('latest', { appendAudit: false }),
      /no complete backup available/
    );
    const live = await liveState(codexHome);
    assert.equal(live['config.toml'], 'model = "live"\n', 'config.toml must survive');
    assert.equal(live['auth.json'], '{"OPENAI_API_KEY":"live"}\n', 'auth.json must survive');
    assert.equal(live['.env'], 'OPENAI_API_KEY=live\n', '.env must survive');
  });
});

test('restoreBackup: "latest" skips a newer incomplete dir and picks the newest complete one', async () => {
  await withIsolatedHome(async ({ codexHome, claudexDir }) => {
    await seedLiveFiles(codexHome, 'v1');
    const good = await takeBackup('v1');
    await seedLiveFiles(codexHome, 'v2');
    await fsp.mkdir(path.join(claudexDir, 'codex-backups', '2099-01-01T00-00-00.000Z'), { recursive: true });

    const r = await restoreBackup('latest', { appendAudit: false });
    assert.equal(r.dir, good);
    assert.equal((await liveState(codexHome))['config.toml'], 'model = "v1"\n');
  });
});

test('restoreBackup: explicit id that is incomplete throws and touches nothing', async () => {
  await withIsolatedHome(async ({ codexHome, claudexDir }) => {
    await seedLiveFiles(codexHome, 'live');
    await fsp.mkdir(path.join(claudexDir, 'codex-backups', '2099-01-01T00-00-00.000Z'), { recursive: true });
    await assert.rejects(
      () => restoreBackup('2099-01-01T00-00-00.000Z', { appendAudit: false }),
      /incomplete/
    );
    assert.equal((await liveState(codexHome))['config.toml'], 'model = "live"\n');
  });
});

test('restoreBackup: unknown id throws', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await seedLiveFiles(codexHome, 'v1');
    await takeBackup('v1');
    await assert.rejects(() => restoreBackup('nope', { appendAudit: false }), /backup not found/);
  });
});

test('restoreBackup: takes a pre-restore backup so the restore itself is undoable', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await seedLiveFiles(codexHome, 'v1');
    await takeBackup('v1');
    // Timestamps have ms precision; make sure the next backup sorts after.
    await new Promise((r) => setTimeout(r, 5));
    await seedLiveFiles(codexHome, 'v2');

    const r = await restoreBackup('latest', { appendAudit: false });
    assert.ok(r.preBackupDir, 'preBackupDir should be reported');
    const backups = await listBackups();
    assert.equal(backups[0].dir, r.preBackupDir, 'pre-restore backup is now the newest');
    assert.equal(backups[0].complete, true);
    const reason = (await fsp.readFile(path.join(r.preBackupDir, 'reason.txt'), 'utf8')).trim();
    assert.match(reason, /^pre-restore /);
    assert.equal(await fsp.readFile(path.join(r.preBackupDir, 'config.toml'), 'utf8'), 'model = "v2"\n');

    // Undo: restore latest again brings v2 back.
    await new Promise((r) => setTimeout(r, 5));
    await restoreBackup('latest', { appendAudit: false });
    assert.equal((await liveState(codexHome))['config.toml'], 'model = "v2"\n');
  });
});

test('restoreBackup: preBackup=false skips the pre-restore backup', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await seedLiveFiles(codexHome, 'v1');
    await takeBackup('v1');
    const before = (await listBackups()).length;
    const r = await restoreBackup('latest', { appendAudit: false, preBackup: false });
    assert.equal(r.preBackupDir, null);
    assert.equal((await listBackups()).length, before);
  });
});

test('restoreBackup: a complete backup that legitimately lacks .env deletes the live .env', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    // Complete backup taken when there was no .env yet.
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "v1"\n');
    await takeBackup('no-env');
    await fsp.writeFile(path.join(codexHome, '.env'), 'OPENAI_API_KEY=later\n');

    const r = await restoreBackup('latest', { appendAudit: false });
    assert.equal(r.deleted.env_file, true);
    assert.equal(fs.existsSync(path.join(codexHome, '.env')), false);
  });
});

// ===== .env drift (env_file_hash was previously dropped from the baseline) =====

test('applyProviderSwitch: records env_file_hash in the baseline', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), '');
    await writeProvider(PROVIDER);
    await applyProviderSwitch(PROVIDER);
    const baseline = await readLastKnownHashes();
    assert.ok(baseline.env_file_hash, 'env_file_hash must be persisted');
  });
});

test('inspectDrift: detects an external edit to ~/.codex/.env', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), '');
    await writeProvider(PROVIDER);
    await applyProviderSwitch(PROVIDER);
    assert.equal((await inspectDrift()).drift.env, null, 'no drift right after switch');

    await fsp.writeFile(path.join(codexHome, '.env'), 'OPENAI_API_KEY=someone-else\n');
    const r = await inspectDrift();
    assert.ok(r.drift.env, '.env change must be reported');
  });
});

test('applyProviderSwitch: .env drift surfaces in onDrift', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), '');
    await writeProvider(PROVIDER);
    await applyProviderSwitch(PROVIDER);
    await fsp.writeFile(path.join(codexHome, '.env'), 'OPENAI_API_KEY=someone-else\n');

    let seen = null;
    await applyProviderSwitch(PROVIDER, {
      onDrift: async (d) => { seen = d; return true; }
    });
    assert.ok(seen, 'onDrift should fire');
    assert.ok(seen.driftedFiles.includes('.env'), JSON.stringify(seen.driftedFiles));
  });
});

test('inspectDrift: baseline without env_file_hash (pre-upgrade) is not reported as drift', async () => {
  await withIsolatedHome(async ({ codexHome, claudexDir }) => {
    await fsp.writeFile(path.join(codexHome, '.env'), 'OPENAI_API_KEY=x\n');
    // Hand-write an old-format baseline that never recorded env_file_hash.
    await fsp.writeFile(
      path.join(claudexDir, 'codex-last-known-hashes.json'),
      JSON.stringify({ schema_version: 1, config_toml_hash: null, auth_json_hash: null, agents_md_hash: null, recorded_at: 'x' })
    );
    const r = await inspectDrift();
    assert.equal(r.drift.env, null);
  });
});
