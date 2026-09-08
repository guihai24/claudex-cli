import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  codexAuditLogPath,
  codexLastKnownHashesPath
} from './constants.js';
import { ensureDir, exists, readJson, writeAtomic } from '../shared/fs-utils.js';

const ACTOR = 'codexx';

/**
 * Append a single audit event as one JSONL line.
 * Caller is responsible for the schema of `event` — we only stamp ts + actor.
 */
export async function appendAuditEvent(event, opts = {}) {
  const file = opts.path || codexAuditLogPath();
  await ensureDir(path.dirname(file));
  const stamped = {
    ts: opts.ts || new Date().toISOString(),
    actor: opts.actor || ACTOR,
    ...event
  };
  const line = JSON.stringify(stamped) + '\n';
  await fsp.appendFile(file, line, { mode: 0o600 });
}

/**
 * Read up to `n` most recent audit events (in chronological order).
 * Returns [] if the log doesn't exist or is empty.
 */
export async function tailAuditLog(n, opts = {}) {
  const file = opts.path || codexAuditLogPath();
  if (!(await exists(file))) return [];
  const raw = await fsp.readFile(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const tail = n > 0 ? lines.slice(-n) : lines;
  return tail.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { malformed: true, raw: l };
    }
  });
}

/**
 * Read the last-known hashes record (from previous successful claudex write).
 * Returns null if no record exists (i.e. claudex has never written before).
 */
export async function readLastKnownHashes(opts = {}) {
  const file = opts.path || codexLastKnownHashesPath();
  if (!(await exists(file))) return null;
  return readJson(file);
}

/**
 * Persist the latest hashes after a successful write.
 */
export async function writeLastKnownHashes(hashes, opts = {}) {
  const file = opts.path || codexLastKnownHashesPath();
  const payload = {
    schema_version: 1,
    config_toml_hash: hashes.config_toml_hash || null,
    auth_json_hash: hashes.auth_json_hash || null,
    env_file_hash: hashes.env_file_hash || null,
    agents_md_hash: hashes.agents_md_hash || null,
    recorded_at: hashes.recorded_at || new Date().toISOString()
  };
  await ensureDir(path.dirname(file));
  const txt = JSON.stringify(payload, null, 2) + '\n';
  await writeAtomic(file, txt, { mode: 0o600 });
}
