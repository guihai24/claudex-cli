import fsp from 'node:fs/promises';
import path from 'node:path';

import { codexConfigTomlPath } from './constants.js';
import { parseConfigToml } from './config-toml.js';
import {
  exists,
  expandTilde,
  writeJson
} from '../shared/fs-utils.js';

const FALLBACK_REVIEW_TEMPLATE_SLUGS = ['gpt-5.6-luna', 'codex-auto-review'];

/**
 * Resolve the model catalog configured by a config.toml string.
 * Relative paths are interpreted relative to config.toml's directory.
 * Returns null when model_catalog_json is not configured.
 */
export function resolveReviewCatalogPath(configText, opts = {}) {
  if (opts.catalogPath !== undefined) return opts.catalogPath;

  let parsed;
  try {
    parsed = parseConfigToml(configText || '');
  } catch (err) {
    throw new Error(`cannot resolve review catalog: config.toml is invalid: ${err.message}`);
  }

  const configured = parsed.model_catalog_json;
  if (typeof configured !== 'string' || configured.trim() === '') return null;

  const expanded = expandTilde(configured.trim());
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(
    path.dirname(opts.configTomlPath || codexConfigTomlPath()),
    expanded
  );
}

/** Resolve model_catalog_json from an on-disk config.toml. */
export async function resolveReviewCatalogPathFromFile(opts = {}) {
  if (opts.catalogPath !== undefined) return opts.catalogPath;
  const configPath = opts.configTomlPath || codexConfigTomlPath();
  if (!(await exists(configPath))) return null;
  const configText = await fsp.readFile(configPath, 'utf8');
  return resolveReviewCatalogPath(configText, { configTomlPath: configPath });
}

/** The review model is provider.auto_review_model, or the main model when unset. */
export function reviewModelForProvider(provider) {
  const explicit = typeof provider.auto_review_model === 'string'
    ? provider.auto_review_model.trim()
    : '';
  return explicit || provider.model;
}

/**
 * Ensure the configured catalog has a hidden entry for the provider's review
 * model and points that entry's auto_review_model_override at itself.
 *
 * Non-actionable states (catalog disabled/missing or no template available)
 * are returned for the caller to surface. Invalid JSON and write failures throw
 * so a provider switch does not silently leave auto-review broken.
 */
export async function syncReviewCatalog(configText, provider, opts = {}) {
  const reviewModel = reviewModelForProvider(provider);
  const catalogPath = resolveReviewCatalogPath(configText, opts);
  if (!catalogPath) {
    return { status: 'not-configured', reviewModel, catalogPath: null, changed: false };
  }
  if (!(await exists(catalogPath))) {
    return { status: 'missing', reviewModel, catalogPath, changed: false };
  }

  let catalog;
  try {
    catalog = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
  } catch (err) {
    throw new Error(`review catalog is unreadable (${catalogPath}): ${err.message}`);
  }
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new Error(`review catalog has no models array: ${catalogPath}`);
  }

  let changed = false;
  let createdFrom = null;
  let mainEntry = catalog.models.find((model) => model?.slug === provider.model);
  if (!mainEntry) {
    const source = findTemplateEntry(catalog.models, provider.model);
    if (!source) {
      return {
        status: 'template-missing',
        reviewModel,
        catalogPath,
        changed: false
      };
    }
    mainEntry = cloneCatalogEntry(source, provider.model);
    mainEntry.visibility = 'hide';
    catalog.models.push(mainEntry);
    changed = true;
    createdFrom = source.slug;
  }

  if (reviewModel !== provider.model) {
    let reviewEntry = catalog.models.find((model) => model?.slug === reviewModel);
    if (!reviewEntry) {
      reviewEntry = cloneCatalogEntry(mainEntry, reviewModel);
      reviewEntry.visibility = 'hide';
      catalog.models.push(reviewEntry);
      changed = true;
    }
    if (reviewEntry.auto_review_model_override !== reviewModel) {
      reviewEntry.auto_review_model_override = reviewModel;
      changed = true;
    }
  }

  // Guardian resolves the active/main catalog entry first, then follows its
  // auto_review_model_override. Keep the pointer on the main entry.
  if (mainEntry.auto_review_model_override !== reviewModel) {
    mainEntry.auto_review_model_override = reviewModel;
    changed = true;
  }
  if (changed && opts.dryRun !== true) {
    await writeJson(catalogPath, catalog);
  }

  return {
    status: changed ? 'synced' : 'already-synced',
    reviewModel,
    catalogPath,
    changed,
    createdFrom
  };
}

/** Read-only catalog consistency check used by status/doctor. */
export async function inspectReviewCatalog(configText, provider, opts = {}) {
  const reviewModel = reviewModelForProvider(provider);
  const catalogPath = resolveReviewCatalogPath(configText, opts);
  if (!catalogPath) {
    return { status: 'not-configured', reviewModel, catalogPath: null };
  }
  if (!(await exists(catalogPath))) {
    return { status: 'missing', reviewModel, catalogPath };
  }

  let catalog;
  try {
    catalog = JSON.parse(await fsp.readFile(catalogPath, 'utf8'));
  } catch (err) {
    return { status: 'invalid', reviewModel, catalogPath, error: err.message };
  }
  if (!catalog || !Array.isArray(catalog.models)) {
    return { status: 'invalid', reviewModel, catalogPath, error: 'models array missing' };
  }

  const mainEntry = catalog.models.find((model) => model?.slug === provider.model);
  if (!mainEntry) {
    return { status: 'entry-missing', reviewModel, catalogPath, missingModel: provider.model };
  }
  if (mainEntry.auto_review_model_override !== reviewModel) {
    return {
      status: 'mismatch',
      reviewModel,
      catalogPath,
      override: mainEntry.auto_review_model_override || null
    };
  }
  if (
    reviewModel !== provider.model &&
    !catalog.models.some((model) => model?.slug === reviewModel)
  ) {
    return { status: 'review-entry-missing', reviewModel, catalogPath };
  }
  return { status: 'synced', reviewModel, catalogPath };
}

function findTemplateEntry(models, mainModel) {
  return (
    models.find((model) => model?.slug === mainModel) ||
    FALLBACK_REVIEW_TEMPLATE_SLUGS
      .map((slug) => models.find((model) => model?.slug === slug))
      .find(Boolean) ||
    null
  );
}

function cloneCatalogEntry(source, slug) {
  const entry = structuredClone(source);
  entry.slug = slug;
  entry.display_name = source.display_name || slug;
  entry.description = `Automatic approval catalog entry: ${slug}`;
  entry.visibility = 'hide';
  entry.auto_review_model_override = slug;
  return entry;
}
