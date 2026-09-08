import path from 'node:path';
import fsp from 'node:fs/promises';

import {
  codexProvidersDir,
  codexCurrentProviderFile,
  isValidProviderName,
  isReservedProviderId,
  CLAUDEX_PROVIDER_PREFIX,
  SCHEMA_VERSION
} from './constants.js';
import {
  exists,
  ensureDir,
  readJson,
  writeJson,
  writeAtomic
} from '../shared/fs-utils.js';

/**
 * List names of all codexx-managed providers (just the basenames, no .json).
 * Returns [] if no provider dir exists yet. Sorted alphabetically.
 */
export async function listProviders(opts = {}) {
  const dir = opts.dir || codexProvidersDir();
  if (!(await exists(dir))) return [];
  const entries = await fsp.readdir(dir);
  return entries
    .filter((e) => e.endsWith('.json'))
    .map((e) => e.slice(0, -'.json'.length))
    .filter((name) => isValidProviderName(name))
    .sort();
}

/**
 * Read a single provider metadata file.
 * Throws if the file does not exist.
 */
export async function readProvider(name, opts = {}) {
  const dir = opts.dir || codexProvidersDir();
  const file = path.join(dir, `${name}.json`);
  if (!(await exists(file))) {
    throw new Error(`provider not found: ${name}`);
  }
  return readJson(file);
}

/**
 * Persist a provider metadata file with mode 0600.
 * Throws on validation errors.
 */
export async function writeProvider(provider, opts = {}) {
  validateProviderShape(provider);
  const dir = opts.dir || codexProvidersDir();
  await ensureDir(dir);
  const file = path.join(dir, `${provider.name}.json`);
  const payload = {
    schema_version: SCHEMA_VERSION,
    ...provider,
    created_at: provider.created_at || new Date().toISOString()
  };
  await writeJson(file, payload, { mode: 0o600 });
  return file;
}

/**
 * Delete a provider metadata file. No-op if missing.
 */
export async function removeProviderFile(name, opts = {}) {
  const dir = opts.dir || codexProvidersDir();
  const file = path.join(dir, `${name}.json`);
  if (!(await exists(file))) return false;
  await fsp.unlink(file);
  return true;
}

/**
 * Read the current active provider name. Returns null if none.
 */
export async function getCurrentProvider(opts = {}) {
  const file = opts.file || codexCurrentProviderFile();
  if (!(await exists(file))) return null;
  const raw = await fsp.readFile(file, 'utf8');
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Set or clear the current active provider name.
 * Pass null/'' to clear.
 */
export async function setCurrentProvider(name, opts = {}) {
  const file = opts.file || codexCurrentProviderFile();
  await ensureDir(path.dirname(file));
  const content = (name || '').toString();
  if (content === '') {
    if (await exists(file)) await fsp.unlink(file);
    return;
  }
  await writeAtomic(file, content + '\n', { mode: 0o600 });
}

/**
 * Resolve a CLI argument (name or 1-based index) to a provider name.
 * Throws when not found / out of range.
 */
export async function resolveProviderArg(input, opts = {}) {
  if (input === undefined || input === null || input === '') {
    throw new Error('no provider specified');
  }
  const names = await listProviders(opts);
  const asString = String(input);
  if (/^\d+$/.test(asString)) {
    const idx = parseInt(asString, 10);
    if (idx < 1 || idx > names.length) {
      throw new Error(`provider index out of range: ${idx} (have ${names.length})`);
    }
    return names[idx - 1];
  }
  if (!names.includes(asString)) {
    throw new Error(`provider not found: ${asString}`);
  }
  return asString;
}

/**
 * Check whether a provider with this name exists.
 */
export async function providerExists(name, opts = {}) {
  const dir = opts.dir || codexProvidersDir();
  return exists(path.join(dir, `${name}.json`));
}

/**
 * Normalise a user-entered base_url.
 *  - Strips trailing slashes.
 *  - If the URL has no path beyond `/`, appends `/v1` (the OpenAI-compatible
 *    default that 95% of providers expect). Most user input mistakes are
 *    "I forgot the /v1 suffix" — auto-fix it but be transparent.
 *  - If the URL already has a path (e.g. `/v1`, `/v2`, `/openai/v1`,
 *    `/api/anthropic`), leave it alone — the user clearly knows.
 *  - Returns the input unchanged if it doesn't parse as a URL (validator
 *    will surface the error downstream).
 */
export function normalizeBaseUrl(input) {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim().replace(/\/+$/, '');
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return input;
  }
  if (u.pathname === '' || u.pathname === '/') {
    return `${u.origin}/v1`;
  }
  return trimmed;
}

/**
 * Patch an existing provider's metadata.
 * Updates can include any user-editable field: base_url, api_key, model,
 * wire_api, model_reasoning_effort, http_headers, disable_response_storage.
 *
 * Immutable fields (name, schema_version, created_at) are silently ignored
 * if passed in updates.
 *
 * Returns the merged provider object as written.
 */
export async function editProvider(name, updates, opts = {}) {
  const dir = opts.dir || codexProvidersDir();
  const current = await readProvider(name, { dir });

  const IMMUTABLE = new Set(['name', 'schema_version', 'created_at']);
  const patch = {};
  for (const [k, v] of Object.entries(updates || {})) {
    if (IMMUTABLE.has(k)) continue;
    if (v === undefined) continue;
    patch[k] = v;
  }

  if (typeof patch.base_url === 'string') {
    patch.base_url = normalizeBaseUrl(patch.base_url);
  }

  const merged = {
    ...current,
    ...patch,
    name: current.name,
    schema_version: current.schema_version || SCHEMA_VERSION,
    created_at: current.created_at,
    updated_at: new Date().toISOString()
  };

  validateProviderShape(merged);

  const file = path.join(dir, `${name}.json`);
  await writeJson(file, merged, { mode: 0o600 });
  return merged;
}

function validateProviderShape(p) {
  if (!p || typeof p !== 'object') throw new Error('provider must be an object');
  if (!isValidProviderName(p.name)) {
    if (isReservedProviderId(p.name)) {
      throw new Error(`provider name '${p.name}' is reserved by Codex`);
    }
    if (typeof p.name === 'string' && p.name.startsWith(CLAUDEX_PROVIDER_PREFIX)) {
      throw new Error(`provider name must not start with '${CLAUDEX_PROVIDER_PREFIX}'`);
    }
    throw new Error(
      `invalid provider name: must match [a-z0-9][a-z0-9_-]{0,63} and not be reserved`
    );
  }
  if (typeof p.base_url !== 'string' || p.base_url.length === 0) {
    throw new Error('base_url is required');
  }
  if (!/^https?:\/\//i.test(p.base_url)) {
    throw new Error('base_url must start with http:// or https://');
  }
  if (typeof p.api_key !== 'string' || p.api_key.length === 0) {
    throw new Error('api_key is required');
  }
  if (typeof p.model !== 'string' || p.model.length === 0) {
    throw new Error('model is required');
  }
  if (p.wire_api !== undefined && p.wire_api !== 'chat' && p.wire_api !== 'responses') {
    throw new Error(`wire_api must be "chat" or "responses" (got "${p.wire_api}")`);
  }
  if (
    p.model_reasoning_effort !== undefined &&
    !['low', 'medium', 'high'].includes(p.model_reasoning_effort)
  ) {
    throw new Error('model_reasoning_effort must be one of: low | medium | high');
  }
}
