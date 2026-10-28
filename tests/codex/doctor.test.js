import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { runDoctor, formatDoctorReport, summariseStatus } from '../../src/codex/doctor.js';
import { writeProvider, setCurrentProvider } from '../../src/codex/providers.js';
import { writeLastKnownHashes } from '../../src/codex/audit.js';
import { applyProviderSwitch } from '../../src/codex/apply-switch.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function mktemp(prefix = 'codexx-doctor-test-') {
  const dir = path.join(os.tmpdir(), prefix + crypto.randomBytes(8).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

async function withIsolatedHome(fn, extraEnv = {}) {
  const codexHome = await mktemp('codex-home-');
  const claudexDir = await mktemp('claudex-dir-');
  const saved = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDEX_CONFIG_DIR: process.env.CLAUDEX_CONFIG_DIR,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    HOME: process.env.HOME
  };
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDEX_CONFIG_DIR = claudexDir;
  // Make HOME = a unique tmp dir so checkProjectLocalConfig walks don't see real home
  const fakeHome = await mktemp('fake-home-');
  process.env.HOME = fakeHome;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn({ codexHome, claudexDir, fakeHome });
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const PROVIDER = {
  name: 'openrouter',
  base_url: 'https://openrouter.ai/api/v1',
  api_key: 'sk-or-FAKE',
  model: 'anthropic/claude-sonnet-4.5',
  wire_api: 'chat'
};

function findCheck(checks, name) {
  return checks.find((c) => c.name === name);
}

// ===== individual check behaviour =====

test('doctor: reports fail when config.toml missing', async () => {
  await withIsolatedHome(async () => {
    const checks = await runDoctor();
    const c = findCheck(checks, 'config_toml_present');
    assert.equal(c.status, 'fail');
  });
});

test('doctor: reports pass when config.toml exists', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "x"\n');
    const checks = await runDoctor();
    const c = findCheck(checks, 'config_toml_present');
    assert.equal(c.status, 'pass');
  });
});

test('doctor: active_provider_set info when none active', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "x"\n');
    const checks = await runDoctor();
    const c = findCheck(checks, 'active_provider_set');
    assert.equal(c.status, 'info');
  });
});

test('doctor: active_provider_set pass after writeProvider + setCurrentProvider', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "x"\n');
    await writeProvider(PROVIDER);
    await setCurrentProvider('openrouter');
    const checks = await runDoctor();
    const c = findCheck(checks, 'active_provider_set');
    assert.equal(c.status, 'pass');
    assert.ok(c.message.includes('openrouter'));
  });
});

test('doctor: active_provider_set fail when pointer present but metadata missing', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "x"\n');
    await setCurrentProvider('ghost');
    const checks = await runDoctor();
    const c = findCheck(checks, 'active_provider_set');
    assert.equal(c.status, 'fail');
  });
});

test('doctor: config_toml_drift = info when no baseline', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "x"\n');
    const checks = await runDoctor();
    const c = findCheck(checks, 'config_toml_drift');
    assert.equal(c.status, 'info');
  });
});

test('doctor: config_toml_drift = pass when hash matches baseline', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), '');
    await writeProvider(PROVIDER);
    await applyProviderSwitch(PROVIDER);
    const checks = await runDoctor();
    const c = findCheck(checks, 'config_toml_drift');
    assert.equal(c.status, 'pass');
  });
});

test('doctor: config_toml_drift = warn when external edit happened after a switch', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), '');
    await writeProvider(PROVIDER);
    await applyProviderSwitch(PROVIDER);
    // Simulate external mutation
    const current = await fsp.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    await fsp.writeFile(path.join(codexHome, 'config.toml'), current + '\n# external edit\n');
    const checks = await runDoctor();
    const c = findCheck(checks, 'config_toml_drift');
    assert.equal(c.status, 'warn');
  });
});

test('doctor: chatgpt_oauth = info when tokens present', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "x"\n');
    await fsp.writeFile(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { id_token: 'jwt', access_token: 'a', refresh_token: 'r' }
      })
    );
    const checks = await runDoctor();
    const c = findCheck(checks, 'chatgpt_oauth');
    assert.equal(c.status, 'info');
    assert.match(c.message, /ChatGPT/);
  });
});

test('doctor: chatgpt_oauth = pass when codexx-managed apikey', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), '');
    await writeProvider(PROVIDER);
    await applyProviderSwitch(PROVIDER);
    const checks = await runDoctor();
    const c = findCheck(checks, 'chatgpt_oauth');
    assert.equal(c.status, 'pass');
  });
});

test('doctor: shell_env_conflict warns when shell key differs from active provider', async () => {
  await withIsolatedHome(
    async ({ codexHome }) => {
      await fsp.writeFile(path.join(codexHome, 'config.toml'), '');
      await writeProvider(PROVIDER);
      await applyProviderSwitch(PROVIDER);
      const checks = await runDoctor();
      const c = findCheck(checks, 'shell_env_conflict');
      assert.equal(c.status, 'warn');
    },
    { OPENAI_API_KEY: 'sk-different-from-provider' }
  );
});

test('doctor: shell_env_conflict pass when shell key matches', async () => {
  await withIsolatedHome(
    async ({ codexHome }) => {
      await fsp.writeFile(path.join(codexHome, 'config.toml'), '');
      await writeProvider(PROVIDER);
      await applyProviderSwitch(PROVIDER);
      const checks = await runDoctor();
      const c = findCheck(checks, 'shell_env_conflict');
      assert.equal(c.status, 'pass');
    },
    { OPENAI_API_KEY: 'sk-or-FAKE' }
  );
});

test('doctor: project_local_config detects .codex/config.toml in cwd subtree', async () => {
  await withIsolatedHome(async ({ codexHome, fakeHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), '');
    const proj = await mktemp('proj-');
    const dotCodex = path.join(proj, '.codex');
    await fsp.mkdir(dotCodex);
    await fsp.writeFile(path.join(dotCodex, 'config.toml'), 'model_provider = "x"\n');
    const checks = await runDoctor({ cwd: proj });
    const c = findCheck(checks, 'project_local_config');
    assert.equal(c.status, 'warn');
  });
});

test('doctor: project_local_config stops at $HOME, ignores user-level config', async () => {
  await withIsolatedHome(async ({ codexHome, fakeHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), '');
    // Place a stray .codex inside fakeHome that mirrors the real user-level layout.
    const homeCodex = path.join(fakeHome, '.codex');
    await fsp.mkdir(homeCodex, { recursive: true });
    await fsp.writeFile(path.join(homeCodex, 'config.toml'), '');
    // cwd = subdir of fakeHome
    const sub = path.join(fakeHome, 'proj');
    await fsp.mkdir(sub);
    const checks = await runDoctor({ cwd: sub });
    const c = findCheck(checks, 'project_local_config');
    assert.equal(c.status, 'pass', JSON.stringify(c));
  });
});

test('doctor: credentials_store warns when set to "keyring"', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(
      path.join(codexHome, 'config.toml'),
      'cli_auth_credentials_store = "keyring"\nmodel = "x"\n'
    );
    const checks = await runDoctor();
    const c = findCheck(checks, 'credentials_store');
    assert.equal(c.status, 'warn');
  });
});

test('doctor: credentials_store pass when default (no key)', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "x"\n');
    const checks = await runDoctor();
    const c = findCheck(checks, 'credentials_store');
    assert.equal(c.status, 'pass');
  });
});

test('doctor: provider_inventory counts providers', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "x"\n');
    await writeProvider({ ...PROVIDER, name: 'a' });
    await writeProvider({ ...PROVIDER, name: 'b' });
    const checks = await runDoctor();
    const c = findCheck(checks, 'provider_inventory');
    assert.equal(c.status, 'pass');
    assert.match(c.message, /2 codexx provider/);
  });
});

test('doctor: review_catalog passes after use syncs the configured model', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    const catalogPath = path.join(codexHome, 'model-catalog-auto-review.json');
    await fsp.writeFile(
      path.join(codexHome, 'config.toml'),
      `model_catalog_json = ${JSON.stringify(catalogPath)}\n`
    );
    await fsp.writeFile(catalogPath, JSON.stringify({
      models: [{ slug: PROVIDER.model, display_name: 'Claude', visibility: 'list' }]
    }));
    await writeProvider(PROVIDER);
    await applyProviderSwitch(PROVIDER);

    const checks = await runDoctor();
    const c = findCheck(checks, 'review_catalog');
    assert.equal(c.status, 'pass');
    assert.ok(c.message.includes(PROVIDER.model));
  });
});

test('doctor: review_catalog warns when the catalog override was removed', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    const catalogPath = path.join(codexHome, 'model-catalog-auto-review.json');
    await fsp.writeFile(
      path.join(codexHome, 'config.toml'),
      `model_catalog_json = ${JSON.stringify(catalogPath)}\n`
    );
    await fsp.writeFile(catalogPath, JSON.stringify({
      models: [{ slug: PROVIDER.model, display_name: 'Claude', visibility: 'list' }]
    }));
    await writeProvider(PROVIDER);
    await applyProviderSwitch(PROVIDER);
    const changed = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
    delete changed.models[0].auto_review_model_override;
    await fsp.writeFile(catalogPath, JSON.stringify(changed));

    const checks = await runDoctor();
    const c = findCheck(checks, 'review_catalog');
    assert.equal(c.status, 'warn');
  });
});

// ===== formatting / summary =====

test('formatDoctorReport: contains every check name', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "x"\n');
    const checks = await runDoctor();
    const out = formatDoctorReport(checks);
    for (const c of checks) {
      assert.ok(out.includes(c.name), `missing: ${c.name}`);
    }
  });
});

test('summariseStatus: fail wins over warn wins over pass', () => {
  assert.equal(summariseStatus([{ status: 'pass' }]), 'pass');
  assert.equal(summariseStatus([{ status: 'pass' }, { status: 'warn' }]), 'warn');
  assert.equal(summariseStatus([{ status: 'pass' }, { status: 'warn' }, { status: 'fail' }]), 'fail');
  assert.equal(summariseStatus([{ status: 'info' }]), 'pass');
});
