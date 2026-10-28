import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const tmpDirs = [];
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function mktemp(prefix = 'codexx-cli-review-') {
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
    CLAUDEX_CONFIG_DIR: process.env.CLAUDEX_CONFIG_DIR,
    CODEXX_API_KEY: process.env.CODEXX_API_KEY
  };
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDEX_CONFIG_DIR = claudexDir;
  delete process.env.CODEXX_API_KEY;
  try {
    return await fn({ codexHome, claudexDir });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function runCodexx(args) {
  return execFileAsync(process.execPath, [path.join(repoRoot, 'bin/codexx.js'), ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8'
  });
}

test('CLI: add --review-model main omits the field so review follows the main model', async () => {
  await withIsolatedHome(async ({ claudexDir }) => {
    await runCodexx([
      'add', '--no-input', '--no-test',
      '--name', 'demo',
      '--base-url', 'https://example.com/v1',
      '--api-key', 'sk-demo',
      '--model', 'main-model',
      '--review-model', 'main',
      '--wire-api', 'chat'
    ]);
    const provider = JSON.parse(await fsp.readFile(
      path.join(claudexDir, 'codex-providers', 'demo.json'),
      'utf8'
    ));
    assert.equal(provider.model, 'main-model');
    assert.equal(provider.auto_review_model, undefined);
  });
});

test('CLI: use syncs a separate review model and sync-review can retarget it', async () => {
  await withIsolatedHome(async ({ codexHome }) => {
    const catalogPath = path.join(codexHome, 'model-catalog-auto-review.json');
    await fsp.writeFile(
      path.join(codexHome, 'config.toml'),
      `model_catalog_json = ${JSON.stringify(catalogPath)}\n`
    );
    await fsp.writeFile(catalogPath, JSON.stringify({
      models: [
        { slug: 'main-model', display_name: 'Main', visibility: 'list' },
        { slug: 'review-cheap', display_name: 'Review', visibility: 'hide' }
      ]
    }, null, 2));

    await runCodexx([
      'add', '--no-input', '--no-test',
      '--name', 'demo',
      '--base-url', 'https://example.com/v1',
      '--api-key', 'sk-demo',
      '--model', 'main-model',
      '--review-model', 'review-cheap',
      '--wire-api', 'chat'
    ]);
    await runCodexx(['use', 'demo', '--no-input']);

    let catalog = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
    assert.equal(
      catalog.models.find((m) => m.slug === 'main-model').auto_review_model_override,
      'review-cheap'
    );
    assert.equal(
      catalog.models.find((m) => m.slug === 'review-cheap').auto_review_model_override,
      'review-cheap'
    );

    await runCodexx(['sync-review', 'desktop-model']);
    catalog = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
    const desktop = catalog.models.find((m) => m.slug === 'desktop-model');
    assert.equal(desktop.auto_review_model_override, 'desktop-model');
    assert.equal(desktop.visibility, 'hide');
  });
});
