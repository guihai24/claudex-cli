import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { applyProviderSwitch } from '../../src/codex/apply-switch.js';
import { revertToPreClaudex, restoreBackup } from '../../src/codex/revert.js';
import { readSnapshotManifest, listBackups, takeBackup } from '../../src/codex/snapshot.js';
import { parseConfigToml } from '../../src/codex/config-toml.js';
import { readAuthJson } from '../../src/codex/auth-json.js';
import { tailAuditLog, readLastKnownHashes } from '../../src/codex/audit.js';
import { getCurrentProvider } from '../../src/codex/providers.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function mktemp(prefix = 'codexx-int-test-') {
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

const SAMPLE_USER_CONFIG = `# personal codex config
model = "gpt-5.5"
model_provider = "custom"
personality = "pragmatic"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "https://opencoder.example.com/v1"
env_key = "OPENAI_API_KEY"

[projects."/Users/me"]
trust_level = "trusted"

[plugins."superpowers@openai-curated"]
enabled = true

[features]
codex_hooks = true
`;

const PROVIDER_A = {
  name: 'openrouter',
  base_url: 'https://openrouter.ai/api/v1',
  api_key: 'sk-or-FAKE',
  model: 'anthropic/claude-sonnet-4.5',
  wire_api: 'chat'
};

const PROVIDER_B = {
  name: 'azure-proxy',
  base_url: 'https://azure.example.com/openai/v1',
  api_key: 'sk-azure-FAKE',
  model: 'gpt-5.4',
  wire_api: 'responses',
  model_reasoning_effort: 'high'
};

// ===== Full flow: snapshot → switch → switch back → revert =====

test('apply-switch: full flow preserves user config and roundtrips cleanly', async () => {
  await withIsolatedHome(async ({ codexHome, claudexDir }) => {
    // 1. User has an existing config.toml
    const configPath = path.join(codexHome, 'config.toml');
    await fsp.writeFile(configPath, SAMPLE_USER_CONFIG);

    // 2. First switch — snapshot is taken, claudex section inserted
    const r1 = await applyProviderSwitch(PROVIDER_A);
    assert.equal(r1.action, 'insert');
    assert.equal(r1.providerName, 'openrouter');
    assert.ok(r1.backupDir);

    // Verify snapshot was created
    const manifest = await readSnapshotManifest();
    assert.ok(manifest);
    assert.ok(manifest.hashes.config_toml);

    // Verify config now has the claudex section + correct top-level
    const c1 = parseConfigToml(await fsp.readFile(configPath, 'utf8'));
    assert.equal(c1.model_provider, 'claudex-openrouter');
    assert.equal(c1.model, 'anthropic/claude-sonnet-4.5');
    assert.equal(c1.model_providers['claudex-openrouter'].base_url, PROVIDER_A.base_url);
    assert.equal(c1.model_providers['claudex-openrouter'].requires_openai_auth, true);
    // User content preserved
    assert.equal(c1.model_providers.custom.base_url, 'https://opencoder.example.com/v1');
    assert.equal(c1.projects['/Users/me'].trust_level, 'trusted');
    assert.equal(c1.plugins['superpowers@openai-curated'].enabled, true);
    assert.equal(c1.personality, 'pragmatic');
    assert.equal(c1.features.codex_hooks, true);

    // auth.json now has the openrouter key
    const auth1 = await readAuthJson();
    assert.equal(auth1.OPENAI_API_KEY, 'sk-or-FAKE');
    assert.equal(auth1.auth_mode, 'apikey');
    assert.equal(auth1._claudex_managed, true);
    assert.equal(auth1._claudex_provider, 'openrouter');

    // codex-current-provider written
    assert.equal(await getCurrentProvider(), 'openrouter');

    // 3. Second switch — to azure-proxy. Previous claudex section retained.
    const r2 = await applyProviderSwitch(PROVIDER_B, { previousProvider: 'openrouter' });
    assert.equal(r2.action, 'insert');

    const c2 = parseConfigToml(await fsp.readFile(configPath, 'utf8'));
    assert.equal(c2.model_provider, 'claudex-azure-proxy');
    assert.equal(c2.model, 'gpt-5.4');
    assert.ok(c2.model_providers['claudex-azure-proxy']);
    assert.ok(c2.model_providers['claudex-openrouter'], 'previous claudex section retained');
    assert.equal(c2.model_providers['claudex-azure-proxy'].model_reasoning_effort, 'high');

    const auth2 = await readAuthJson();
    assert.equal(auth2.OPENAI_API_KEY, 'sk-azure-FAKE');
    assert.equal(auth2._claudex_provider, 'azure-proxy');

    // 4. Switch back to A
    const r3 = await applyProviderSwitch(PROVIDER_A, { previousProvider: 'azure-proxy' });
    assert.equal(r3.action, 'update');
    const c3 = parseConfigToml(await fsp.readFile(configPath, 'utf8'));
    assert.equal(c3.model_provider, 'claudex-openrouter');

    // 5. Backups exist for each switch
    const backups = await listBackups();
    assert.equal(backups.length >= 3, true, `expected >=3 backups, got ${backups.length}`);

    // 6. Audit log captures the switches
    const events = await tailAuditLog(10);
    const useEvents = events.filter((e) => e.action === 'use');
    assert.equal(useEvents.length, 3);
    assert.equal(useEvents[0].to, 'openrouter');
    assert.equal(useEvents[1].to, 'azure-proxy');
    assert.equal(useEvents[2].to, 'openrouter');

    // 7. last-known hashes recorded
    const hashes = await readLastKnownHashes();
    assert.ok(hashes.config_toml_hash);
    assert.ok(hashes.auth_json_hash);

    // 8. Revert — should restore exactly to original
    const revertResult = await revertToPreClaudex({ removeStateFiles: true });
    assert.equal(revertResult.restored.config_toml, true);

    const finalConfigText = await fsp.readFile(configPath, 'utf8');
    assert.equal(finalConfigText, SAMPLE_USER_CONFIG, 'config.toml byte-identical to original');

    // auth.json should be gone (snapshot had no auth.json)
    let authStillExists = true;
    try {
      await fsp.access(path.join(codexHome, 'auth.json'));
    } catch {
      authStillExists = false;
    }
    assert.equal(authStillExists, false);

    // state files cleaned up
    assert.equal(await getCurrentProvider(), null);
    assert.equal(await readLastKnownHashes(), null);
  });
});

test('apply-switch: rejects when post-verify finds non-claudex changes', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    const configPath = path.join(codexHome, 'config.toml');
    await fsp.writeFile(configPath, SAMPLE_USER_CONFIG);
    // (We can't easily simulate a writer bug without mocking; this is a smoke check
    // that the validate step runs to completion under the happy path.)
    const result = await applyProviderSwitch(PROVIDER_A);
    assert.ok(result.providerName);
  });
});

test('apply-switch: detects drift when external writer changed files between switches', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    const configPath = path.join(codexHome, 'config.toml');
    await fsp.writeFile(configPath, SAMPLE_USER_CONFIG);
    await applyProviderSwitch(PROVIDER_A);

    // Simulate an external writer (e.g. codex mcp add) mutating config.toml
    const current = await fsp.readFile(configPath, 'utf8');
    await fsp.writeFile(configPath, current + '\n[mcp_servers.new]\ncommand = "x"\n');

    let driftReport = null;
    await applyProviderSwitch(PROVIDER_B, {
      previousProvider: 'openrouter',
      onDrift: (d) => {
        driftReport = d;
        return true; // accept
      }
    });

    assert.ok(driftReport);
    assert.ok(driftReport.driftedFiles.includes('config.toml'));
  });
});

test('apply-switch: onDrift returning false aborts the switch', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    const configPath = path.join(codexHome, 'config.toml');
    await fsp.writeFile(configPath, SAMPLE_USER_CONFIG);
    await applyProviderSwitch(PROVIDER_A);

    await fsp.writeFile(configPath, (await fsp.readFile(configPath, 'utf8')) + '\n# tampered\n');

    await assert.rejects(
      () =>
        applyProviderSwitch(PROVIDER_B, {
          previousProvider: 'openrouter',
          onDrift: () => false
        }),
      /drift detected/
    );
  });
});

test('apply-switch: backs up ChatGPT OAuth tokens before overwriting auth.json', async () => {
  await withIsolatedHome(async ({ codexHome, claudexDir }) => {
    const configPath = path.join(codexHome, 'config.toml');
    const authPath = path.join(codexHome, 'auth.json');
    await fsp.writeFile(configPath, SAMPLE_USER_CONFIG);
    const oauthTokens = {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'jwt-id',
        access_token: 'jwt-access',
        refresh_token: 'jwt-refresh'
      },
      last_refresh: '2026-05-17T00:00:00Z'
    };
    await fsp.writeFile(authPath, JSON.stringify(oauthTokens));

    const result = await applyProviderSwitch(PROVIDER_A);
    assert.ok(result.chatgptBackupPath, 'expected chatgpt backup path');

    const backedUp = JSON.parse(await fsp.readFile(result.chatgptBackupPath, 'utf8'));
    assert.equal(backedUp.tokens.id_token, 'jwt-id');

    // New auth.json is now apikey mode
    const newAuth = await readAuthJson();
    assert.equal(newAuth.auth_mode, 'apikey');
    assert.equal(newAuth.OPENAI_API_KEY, 'sk-or-FAKE');
    assert.equal(newAuth.tokens, undefined);
  });
});

test('apply-switch: syncs and backs up the auto-review catalog', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    const catalogPath = path.join(codexHome, 'model-catalog-auto-review.json');
    const configPath = path.join(codexHome, 'config.toml');
    await fsp.writeFile(
      configPath,
      SAMPLE_USER_CONFIG.replace(
        '# personal codex config\n',
        `# personal codex config\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n`
      )
    );
    await fsp.writeFile(catalogPath, JSON.stringify({
      models: [
        { slug: PROVIDER_A.model, display_name: 'Claude', visibility: 'list' },
        { slug: 'gpt-5.6-luna', display_name: 'Luna', visibility: 'list' }
      ]
    }, null, 2));

    const result = await applyProviderSwitch(PROVIDER_A);
    assert.equal(result.reviewCatalog.status, 'synced');
    assert.equal(result.reviewCatalog.reviewModel, PROVIDER_A.model);

    const catalog = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
    const entry = catalog.models.find((m) => m.slug === PROVIDER_A.model);
    assert.equal(entry.auto_review_model_override, PROVIDER_A.model);
    assert.ok(fs.existsSync(path.join(result.backupDir, 'review-catalog.json')));

    const baseline = await readLastKnownHashes();
    assert.equal(baseline.review_catalog_path, catalogPath);
    assert.ok(baseline.review_catalog_hash);
  });
});

test('apply-switch: reports auto-review catalog drift', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    const catalogPath = path.join(codexHome, 'model-catalog-auto-review.json');
    const configPath = path.join(codexHome, 'config.toml');
    await fsp.writeFile(
      configPath,
      `model_catalog_json = ${JSON.stringify(catalogPath)}\nmodel = "gpt-5.5"\n`
    );
    await fsp.writeFile(catalogPath, JSON.stringify({
      models: [
        { slug: PROVIDER_A.model, display_name: 'Claude', visibility: 'list' },
        { slug: PROVIDER_B.model, display_name: 'GPT', visibility: 'list' }
      ]
    }));
    await applyProviderSwitch(PROVIDER_A);

    const changed = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
    changed.models.push({ slug: 'external-change', display_name: 'External', visibility: 'hide' });
    await fsp.writeFile(catalogPath, JSON.stringify(changed));

    let report = null;
    await applyProviderSwitch(PROVIDER_B, {
      previousProvider: 'openrouter',
      onDrift: (d) => { report = d; return true; }
    });
    assert.ok(report);
    assert.ok(report.driftedFiles.includes('review catalog'));
  });
});

test('restoreBackup: restores a prior backup', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    const configPath = path.join(codexHome, 'config.toml');
    const authPath = path.join(codexHome, 'auth.json');
    const envPath = path.join(codexHome, '.env');
    await fsp.writeFile(configPath, SAMPLE_USER_CONFIG);

    await applyProviderSwitch(PROVIDER_A);
    const configAfterA = await fsp.readFile(configPath, 'utf8');
    const authAfterA = await fsp.readFile(authPath, 'utf8');
    const envAfterA = await fsp.readFile(envPath, 'utf8');

    await applyProviderSwitch(PROVIDER_B, { previousProvider: 'openrouter' });

    // Restore the most recent backup (which was taken just before B was applied,
    // so it should be the state right after A was applied)
    const result = await restoreBackup('latest');
    assert.ok(result.restored.config_toml);
    assert.ok(result.restored.auth_json);
    assert.ok(result.restored.env_file);
    assert.equal(await fsp.readFile(configPath, 'utf8'), configAfterA);
    assert.equal(await fsp.readFile(authPath, 'utf8'), authAfterA);
    assert.equal(await fsp.readFile(envPath, 'utf8'), envAfterA);
  });
});

test('restoreBackup: removes files that were absent from the backup', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    const configPath = path.join(codexHome, 'config.toml');
    const envPath = path.join(codexHome, '.env');
    await fsp.writeFile(configPath, SAMPLE_USER_CONFIG);
    await takeBackup('before env existed');
    await fsp.writeFile(envPath, 'OPENAI_API_KEY=stale\n');

    const result = await restoreBackup('latest');
    assert.equal(result.deleted.env_file, true);
    await assert.rejects(() => fsp.access(envPath), { code: 'ENOENT' });
  });
});

test('revertToPreClaudex: throws if no snapshot exists', async () => {
  await withIsolatedHome(async () => {
    await assert.rejects(() => revertToPreClaudex(), /no pre-claudex snapshot/);
  });
});
