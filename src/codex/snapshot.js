import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  codexHome,
  codexConfigTomlPath,
  codexAuthJsonPath,
  codexAgentsMdPath,
  codexEnvFilePath,
  codexSnapshotDir,
  codexBackupsDir,
  SCHEMA_VERSION
} from './constants.js';
import {
  exists,
  ensureDir,
  readJson,
  writeJson,
  writeAtomic,
  sha256File,
  isoStamp
} from '../shared/fs-utils.js';

/**
 * Capture the pre-claudex state of ~/.codex/ — exactly once.
 * Idempotent: if snapshot already exists, no-op.
 * Returns { taken: boolean, dir: string }.
 */
export async function ensurePreClaudexSnapshot(opts = {}) {
  const dir = opts.dir || codexSnapshotDir();
  const manifestPath = path.join(dir, 'manifest.json');
  if (await exists(manifestPath)) return { taken: false, dir };

  await ensureDir(dir);
  const configPath = opts.configTomlPath || codexConfigTomlPath();
  const authPath = opts.authJsonPath || codexAuthJsonPath();
  const agentsPath = opts.agentsMdPath || codexAgentsMdPath();
  const envPath = opts.envFilePath || codexEnvFilePath();

  const manifest = {
    schema_version: SCHEMA_VERSION,
    ts: new Date().toISOString(),
    codex_home: opts.codexHomePath || codexHome(),
    hashes: {}
  };

  if (await exists(configPath)) {
    const dst = path.join(dir, 'config.toml');
    await fsp.copyFile(configPath, dst);
    manifest.hashes.config_toml = await sha256File(dst);
  } else {
    manifest.hashes.config_toml = null;
  }

  if (await exists(authPath)) {
    const dst = path.join(dir, 'auth.json');
    await fsp.copyFile(authPath, dst);
    await fsp.chmod(dst, 0o600);
    manifest.hashes.auth_json = await sha256File(dst);
  } else {
    manifest.hashes.auth_json = null;
  }

  if (await exists(agentsPath)) {
    const dst = path.join(dir, 'AGENTS.md');
    await fsp.copyFile(agentsPath, dst);
    manifest.hashes.agents_md = await sha256File(dst);
  } else {
    manifest.hashes.agents_md = null;
  }

  if (await exists(envPath)) {
    const dst = path.join(dir, '.env');
    await fsp.copyFile(envPath, dst);
    await fsp.chmod(dst, 0o600);
    manifest.hashes.env_file = await sha256File(dst);
  } else {
    manifest.hashes.env_file = null;
  }

  await writeJson(manifestPath, manifest);
  return { taken: true, dir };
}

/**
 * Read the snapshot manifest. Returns null if no snapshot exists.
 */
export async function readSnapshotManifest(opts = {}) {
  const dir = opts.dir || codexSnapshotDir();
  const manifestPath = path.join(dir, 'manifest.json');
  if (!(await exists(manifestPath))) return null;
  return readJson(manifestPath);
}

/**
 * Take a timestamped backup of current ~/.codex/ files before a write.
 * Returns the backup directory path.
 */
export async function takeBackup(reason, opts = {}) {
  const stamp = opts.timestamp || isoStamp();
  const root = opts.root || codexBackupsDir();
  const dir = path.join(root, stamp);
  await ensureDir(dir);

  const configPath = opts.configTomlPath || codexConfigTomlPath();
  const authPath = opts.authJsonPath || codexAuthJsonPath();
  const envPath = opts.envFilePath || codexEnvFilePath();
  const hashes = { config_toml: null, auth_json: null, env_file: null };

  if (await exists(configPath)) {
    const dst = path.join(dir, 'config.toml');
    await fsp.copyFile(configPath, dst);
    hashes.config_toml = await sha256File(dst);
  }
  if (await exists(authPath)) {
    const dst = path.join(dir, 'auth.json');
    await fsp.copyFile(authPath, dst);
    await fsp.chmod(dst, 0o600);
    hashes.auth_json = await sha256File(dst);
  }
  if (await exists(envPath)) {
    const dst = path.join(dir, '.env');
    await fsp.copyFile(envPath, dst);
    await fsp.chmod(dst, 0o600);
    hashes.env_file = await sha256File(dst);
  }

  await writeAtomic(
    path.join(dir, 'reason.txt'),
    `${reason || 'unspecified'}\n`
  );
  // Must stay the LAST write in this function — see listBackups.
  await writeJson(path.join(dir, BACKUP_MANIFEST_FILE), {
    ts: stamp,
    reason: reason || null,
    hashes
  });

  return dir;
}

/** Written last by takeBackup, so its presence marks a backup as complete. */
export const BACKUP_MANIFEST_FILE = 'hashes.json';

/**
 * List all timestamped backups, newest first.
 * Each entry: { id (=basename), dir, complete }.
 *
 * `complete` is false when hashes.json is missing — i.e. takeBackup was
 * interrupted between ensureDir and its final write. Such directories are
 * still listed so pruneBackups can clean them up, but restoreBackup must
 * refuse them: a backup with no config.toml would otherwise be read as
 * "config.toml did not exist" and the live file would be deleted.
 */
export async function listBackups(opts = {}) {
  const root = opts.root || codexBackupsDir();
  if (!(await exists(root))) return [];
  const entries = await fsp.readdir(root);
  const filtered = [];
  for (const name of entries) {
    const full = path.join(root, name);
    const stat = await fsp.stat(full);
    if (!stat.isDirectory()) continue;
    const complete = await exists(path.join(full, BACKUP_MANIFEST_FILE));
    filtered.push({ id: name, dir: full, complete });
  }
  // newest first by id (ISO timestamps sort chronologically as strings)
  filtered.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return filtered;
}

/**
 * Prune old backups beyond retention.
 * Default: keep the most recent `keepCount` AND anything within `keepDays` days.
 * Returns { removed: number, kept: number }.
 */
export async function pruneBackups(opts = {}) {
  const keepCount = opts.keepCount ?? 5;
  const keepDays = opts.keepDays ?? 7;
  const now = opts.now || new Date();
  const cutoffMs = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const backups = await listBackups(opts);
  let removed = 0;
  let kept = 0;
  for (let i = 0; i < backups.length; i++) {
    const entry = backups[i];
    let withinTime = false;
    const parsed = parseIsoStampish(entry.id);
    if (parsed && parsed.getTime() >= cutoffMs) withinTime = true;
    const withinCount = i < keepCount;
    if (withinTime || withinCount) {
      kept++;
    } else {
      await fsp.rm(entry.dir, { recursive: true, force: true });
      removed++;
    }
  }
  return { removed, kept };
}

function parseIsoStampish(s) {
  // isoStamp replaces ":" with "-"; reverse for parse
  if (typeof s !== 'string') return null;
  // Format: YYYY-MM-DDTHH-MM-SS.sssZ
  const re = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{3}))?Z$/;
  const m = s.match(re);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? '.' + m[7] : ''}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
