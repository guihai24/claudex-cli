import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  inspectReviewCatalog,
  resolveReviewCatalogPath,
  reviewModelForProvider,
  syncReviewCatalog
} from '../../src/codex/review-catalog.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function mktemp(prefix = 'codexx-review-catalog-') {
  const dir = path.join(os.tmpdir(), prefix + crypto.randomBytes(8).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

const CATALOG = {
  models: [
    {
      slug: 'main-model',
      display_name: 'Main Model',
      visibility: 'list',
      default_reasoning_level: 'medium'
    },
    {
      slug: 'gpt-5.6-luna',
      display_name: 'GPT-5.6-Luna',
      visibility: 'list'
    }
  ]
};

const PROVIDER = {
  name: 'demo',
  base_url: 'https://example.com/v1',
  api_key: 'sk-demo',
  model: 'main-model'
};

async function fixture() {
  const dir = await mktemp();
  const configPath = path.join(dir, 'config.toml');
  const catalogPath = path.join(dir, 'catalog.json');
  const configText = `model = "main-model"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n`;
  await fsp.writeFile(configPath, configText);
  await fsp.writeFile(catalogPath, JSON.stringify(CATALOG, null, 2) + '\n');
  return { dir, configPath, catalogPath, configText };
}

test('review model defaults to the main model and trims an explicit override', () => {
  assert.equal(reviewModelForProvider(PROVIDER), 'main-model');
  assert.equal(reviewModelForProvider({ ...PROVIDER, auto_review_model: '  review-x  ' }), 'review-x');
});

test('resolveReviewCatalogPath supports absolute and config-relative paths', async () => {
  const dir = await mktemp();
  const configPath = path.join(dir, 'config.toml');
  assert.equal(
    resolveReviewCatalogPath('model_catalog_json = "/tmp/catalog.json"\n', { configTomlPath: configPath }),
    '/tmp/catalog.json'
  );
  assert.equal(
    resolveReviewCatalogPath('model_catalog_json = "catalog.json"\n', { configTomlPath: configPath }),
    path.join(dir, 'catalog.json')
  );
  assert.equal(resolveReviewCatalogPath('model = "x"\n', { configTomlPath: configPath }), null);
});

test('syncReviewCatalog points an existing main-model entry at itself', async () => {
  const { configText, catalogPath } = await fixture();
  const result = await syncReviewCatalog(configText, PROVIDER);
  assert.equal(result.status, 'synced');
  const catalog = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
  const main = catalog.models.find((m) => m.slug === 'main-model');
  assert.equal(main.auto_review_model_override, 'main-model');
  assert.equal(main.visibility, 'list', 'existing catalog visibility must be preserved');
});

test('syncReviewCatalog clones the main entry for a separate hidden review model', async () => {
  const { configText, catalogPath } = await fixture();
  const result = await syncReviewCatalog(configText, {
    ...PROVIDER,
    auto_review_model: 'cheap-review'
  });
  assert.equal(result.status, 'synced');
  const catalog = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
  const main = catalog.models.find((m) => m.slug === 'main-model');
  const review = catalog.models.find((m) => m.slug === 'cheap-review');
  assert.equal(main.auto_review_model_override, 'cheap-review');
  assert.equal(review.auto_review_model_override, 'cheap-review');
  assert.equal(review.visibility, 'hide');
  assert.equal(review.default_reasoning_level, 'medium');
});

test('syncReviewCatalog creates a missing main entry and points it at a separate review model', async () => {
  const { configText, catalogPath } = await fixture();
  const result = await syncReviewCatalog(configText, {
    ...PROVIDER,
    model: 'not-in-catalog',
    auto_review_model: 'review-x'
  });
  assert.equal(result.status, 'synced');
  assert.equal(result.createdFrom, 'gpt-5.6-luna');
  const catalog = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
  const main = catalog.models.find((m) => m.slug === 'not-in-catalog');
  const review = catalog.models.find((m) => m.slug === 'review-x');
  assert.equal(main.auto_review_model_override, 'review-x');
  assert.equal(main.visibility, 'hide');
  assert.equal(review.visibility, 'hide');
});

test('syncReviewCatalog is idempotent and inspect reports a consistent catalog', async () => {
  const { configText } = await fixture();
  await syncReviewCatalog(configText, PROVIDER);
  const again = await syncReviewCatalog(configText, PROVIDER);
  assert.equal(again.status, 'already-synced');
  const inspected = await inspectReviewCatalog(configText, PROVIDER);
  assert.equal(inspected.status, 'synced');
  assert.equal(inspected.reviewModel, 'main-model');
});

test('syncReviewCatalog returns non-actionable statuses for absent config/catalog/template', async () => {
  const dir = await mktemp();
  const configPath = path.join(dir, 'config.toml');
  const noConfig = await syncReviewCatalog('model = "x"\n', PROVIDER, { configTomlPath: configPath });
  assert.equal(noConfig.status, 'not-configured');

  const missingPath = path.join(dir, 'missing.json');
  const missing = await syncReviewCatalog(
    `model_catalog_json = ${JSON.stringify(missingPath)}\n`,
    PROVIDER,
    { configTomlPath: configPath }
  );
  assert.equal(missing.status, 'missing');

  await fsp.writeFile(missingPath, JSON.stringify({ models: [] }));
  const noTemplate = await syncReviewCatalog(
    `model_catalog_json = ${JSON.stringify(missingPath)}\n`,
    PROVIDER,
    { configTomlPath: configPath }
  );
  assert.equal(noTemplate.status, 'template-missing');
});

test('inspectReviewCatalog reports mismatches without modifying the catalog', async () => {
  const { configText, catalogPath } = await fixture();
  const before = await fsp.readFile(catalogPath, 'utf8');
  const inspected = await inspectReviewCatalog(configText, PROVIDER);
  assert.equal(inspected.status, 'mismatch');
  assert.equal(await fsp.readFile(catalogPath, 'utf8'), before);
});

test('syncReviewCatalog rejects an invalid catalog instead of silently switching', async () => {
  const { configText, catalogPath } = await fixture();
  await fsp.writeFile(catalogPath, '{broken');
  await assert.rejects(
    () => syncReviewCatalog(configText, PROVIDER),
    /review catalog is unreadable/
  );
});
