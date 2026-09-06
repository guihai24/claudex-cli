import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  codexConfigTomlPath,
  codexAuthJsonPath,
  codexEnvFilePath
} from './constants.js';
import { exists, sha256, sha256File } from '../shared/fs-utils.js';
import {
  readLastKnownHashes,
  writeLastKnownHashes,
  appendAuditEvent
} from './audit.js';
import { readAuthJson } from './auth-json.js';

/**
 * Inspect the current state vs codexx's last-known baseline.
 * Returns { baseline, current, drift: { config, auth, env } }.
 * Each drift entry is null (no baseline / no current change) or { before, after }.
 */
export async function inspectDrift() {
  const baseline = await readLastKnownHashes();
  const configPath = codexConfigTomlPath();
  const authPath = codexAuthJsonPath();
  const envPath = codexEnvFilePath();

  const currentConfigHash = (await exists(configPath))
    ? await sha256File(configPath)
    : null;
  const currentAuth = await readAuthJson();
  const currentAuthHash = currentAuth ? sha256(JSON.stringify(currentAuth)) : null;
  const currentEnvHash = (await exists(envPath))
    ? await sha256File(envPath)
    : null;

  const drift = { config: null, auth: null, env: null };
  if (baseline) {
    if (baseline.config_toml_hash && baseline.config_toml_hash !== currentConfigHash) {
      drift.config = { before: baseline.config_toml_hash, after: currentConfigHash };
    }
    if ((baseline.auth_json_hash || null) !== (currentAuthHash || null)) {
      drift.auth = { before: baseline.auth_json_hash, after: currentAuthHash };
    }
    // Only compare when the baseline actually recorded an env hash — older
    // baselines predate the field and must not be reported as drift.
    if (baseline.env_file_hash && baseline.env_file_hash !== currentEnvHash) {
      drift.env = { before: baseline.env_file_hash, after: currentEnvHash };
    }
  }

  return {
    baseline,
    current: {
      config_toml_hash: currentConfigHash,
      auth_json_hash: currentAuthHash,
      env_file_hash: currentEnvHash
    },
    drift
  };
}

/**
 * Accept whatever is currently on disk as the new baseline.
 * Updates last-known-hashes so future drift detection treats this as canonical.
 */
export async function acceptExternalChanges() {
  const inspection = await inspectDrift();
  await writeLastKnownHashes({
    config_toml_hash: inspection.current.config_toml_hash,
    auth_json_hash: inspection.current.auth_json_hash,
    env_file_hash: inspection.current.env_file_hash,
    recorded_at: new Date().toISOString()
  });
  await appendAuditEvent({
    action: 'reconcile',
    strategy: 'accept_external',
    drift: inspection.drift
  });
  return inspection;
}
