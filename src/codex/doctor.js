import path from 'node:path';
import fsp from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';

import {
  codexConfigTomlPath,
  codexAuthJsonPath,
  codexEnvFilePath
} from './constants.js';
import { exists, sha256, sha256File } from '../shared/fs-utils.js';
import { readLastKnownHashes } from './audit.js';
import { readAuthJson, inspectAuthJson, detectChatGptAuth } from './auth-json.js';
import { getCurrentProvider, readProvider, listProviders } from './providers.js';
import {
  detectCodex,
  detectCodexAppRunning,
  preflight
} from './launch.js';
import { ENV_MARKER_BEGIN, ENV_MARKER_END } from './env-file.js';
import { inspectReviewCatalog } from './review-catalog.js';

/**
 * One diagnostic check result.
 * status: 'pass' | 'warn' | 'fail' | 'info'
 */

/**
 * Run all doctor checks.
 * @param {object} opts
 *   - provider: name to optionally probe connectivity against
 *   - cwd: working directory for project-local config detection (default process.cwd)
 *   - skipConnectivity: don't probe HTTP (default true; explicit opt-in)
 */
export async function runDoctor(opts = {}) {
  const checks = [];
  const cwd = opts.cwd || process.cwd();

  checks.push(await checkCodexInstalled());
  checks.push(await checkCodexVersion());
  checks.push(await checkCodexAppRunning());
  checks.push(await checkActiveProvider());
  checks.push(await checkConfigTomlExists());
  checks.push(await checkConfigDrift());
  checks.push(await checkAuthDrift());
  checks.push(await checkChatGptCoexistence());
  checks.push(await checkShellEnvConflict());
  checks.push(await checkProjectLocalConfig(cwd));
  checks.push(await checkCredentialsStoreMode());
  checks.push(await checkEnvFile());
  checks.push(await checkProviderInventory());
  checks.push(await checkReviewCatalog());

  return checks;
}

// ----- individual checks -----

async function checkCodexInstalled() {
  const c = detectCodex();
  if (!c.installed) {
    return {
      name: 'codex_cli_installed',
      status: 'fail',
      message: 'Codex CLI not found on PATH',
      fix: 'Install Codex: https://developers.openai.com/codex'
    };
  }
  return {
    name: 'codex_cli_installed',
    status: 'pass',
    message: `Codex CLI installed: ${c.path}`,
    meta: { path: c.path, version: c.version }
  };
}

async function checkCodexVersion() {
  const c = detectCodex();
  if (!c.installed || !c.version) {
    return {
      name: 'codex_cli_version',
      status: 'info',
      message: 'Codex version unknown'
    };
  }
  // Codex versions look like 0.NNN.M; treat minor >= 130 as having hot reload.
  const parts = c.version.split('.').map((n) => parseInt(n, 10));
  const minor = parts[1] || 0;
  if (minor < 130) {
    return {
      name: 'codex_cli_version',
      status: 'warn',
      message: `Codex ${c.version} < v0.130 (no config hot reload)`,
      fix: 'Consider upgrading Codex for hot-reload of switched providers'
    };
  }
  return {
    name: 'codex_cli_version',
    status: 'pass',
    message: `Codex ${c.version} supports config hot reload`
  };
}

async function checkCodexAppRunning() {
  const app = detectCodexAppRunning();
  if (app === null) {
    return { name: 'codex_app_running', status: 'info', message: 'Desktop App detection not supported on this platform' };
  }
  if (app.running) {
    // Provider config hot-reloads, but Codex loads model_catalog_json only at
    // app-server startup. A switch that changes auto-review metadata still
    // needs a restart.
    const c = detectCodex();
    const parts = (c.version || '0.0.0').split('.').map((n) => parseInt(n, 10));
    const minor = parts[1] || 0;
    if (minor >= 130) {
      return {
        name: 'codex_app_running',
        status: 'pass',
        message: `Codex Desktop App is running (PID ${app.pid}); provider config hot-reloads, but auto-review catalog changes need a restart`
      };
    }
    return {
      name: 'codex_app_running',
      status: 'warn',
      message: `Codex Desktop App is running (PID ${app.pid})`,
      fix: 'Restart the Desktop App to apply provider changes (codex < v0.130 has no hot reload)'
    };
  }
  return { name: 'codex_app_running', status: 'pass', message: 'Codex Desktop App not running' };
}

async function checkActiveProvider() {
  const name = await getCurrentProvider();
  if (!name) {
    return {
      name: 'active_provider_set',
      status: 'info',
      message: 'No active codexx provider',
      fix: 'Run codexx use <name>'
    };
  }
  try {
    const p = await readProvider(name);
    return {
      name: 'active_provider_set',
      status: 'pass',
      message: `Active provider: ${name} (${p.base_url})`,
      meta: { name, base_url: p.base_url, model: p.model, wire_api: p.wire_api || 'responses' }
    };
  } catch (err) {
    return {
      name: 'active_provider_set',
      status: 'fail',
      message: `Active provider points to '${name}' but metadata missing: ${err.message}`,
      fix: 'Run codexx add to re-create the provider, or codexx use <other>'
    };
  }
}

async function checkConfigTomlExists() {
  const p = codexConfigTomlPath();
  if (!(await exists(p))) {
    return {
      name: 'config_toml_present',
      status: 'fail',
      message: `${p} does not exist`,
      fix: 'Run codex once to initialise its config, or codexx use <name> to create it'
    };
  }
  return { name: 'config_toml_present', status: 'pass', message: `${p} exists` };
}

async function checkConfigDrift() {
  const lastKnown = await readLastKnownHashes();
  const p = codexConfigTomlPath();
  if (!lastKnown) {
    return {
      name: 'config_toml_drift',
      status: 'info',
      message: 'No baseline yet (no codexx switch on record)'
    };
  }
  if (!(await exists(p))) {
    return {
      name: 'config_toml_drift',
      status: 'fail',
      message: 'config.toml is missing but codexx baseline exists'
    };
  }
  const current = await sha256File(p);
  if (lastKnown.config_toml_hash && current === lastKnown.config_toml_hash) {
    return { name: 'config_toml_drift', status: 'pass', message: 'config.toml matches last codexx write' };
  }
  return {
    name: 'config_toml_drift',
    status: 'warn',
    message: 'config.toml has changed since last codexx write (likely codex mcp/plugin/login or manual edit)',
    fix: 'Run codexx reconcile to accept external changes, or codexx use <name> to re-apply'
  };
}

async function checkAuthDrift() {
  const lastKnown = await readLastKnownHashes();
  const p = codexAuthJsonPath();
  if (!lastKnown) {
    return {
      name: 'auth_json_drift',
      status: 'info',
      message: 'No baseline yet'
    };
  }
  if (!(await exists(p))) {
    if (lastKnown.auth_json_hash === null) {
      return { name: 'auth_json_drift', status: 'pass', message: 'auth.json absent (matches baseline)' };
    }
    return {
      name: 'auth_json_drift',
      status: 'warn',
      message: 'auth.json missing but baseline expected it (codex logout?)'
    };
  }
  const auth = await readAuthJson();
  const current = sha256(JSON.stringify(auth));
  if (lastKnown.auth_json_hash && current === lastKnown.auth_json_hash) {
    return { name: 'auth_json_drift', status: 'pass', message: 'auth.json matches last codexx write' };
  }
  return {
    name: 'auth_json_drift',
    status: 'warn',
    message: 'auth.json has changed since last codexx write (codex login? external edit?)',
    fix: 'Run codexx reconcile or codexx use <name> to re-apply'
  };
}

async function checkChatGptCoexistence() {
  const auth = await readAuthJson();
  if (!auth) {
    return { name: 'chatgpt_oauth', status: 'info', message: 'No auth.json present' };
  }
  const inspect = inspectAuthJson(auth);
  if (inspect.hasChatGptTokens) {
    return {
      name: 'chatgpt_oauth',
      status: 'info',
      message: 'auth.json holds ChatGPT OAuth tokens (codex is in ChatGPT subscription mode)'
    };
  }
  if (inspect.claudexManaged) {
    return {
      name: 'chatgpt_oauth',
      status: 'pass',
      message: `auth.json is codexx-managed for provider '${inspect.claudexProvider || 'unknown'}'`
    };
  }
  return { name: 'chatgpt_oauth', status: 'info', message: 'auth.json is in apikey mode (not codexx-managed)' };
}

async function checkShellEnvConflict() {
  const shellKey = process.env.OPENAI_API_KEY;
  const active = await getCurrentProvider();
  if (!shellKey && !active) {
    return { name: 'shell_env_conflict', status: 'pass', message: 'no OPENAI_API_KEY in shell env' };
  }
  if (shellKey && !active) {
    return {
      name: 'shell_env_conflict',
      status: 'info',
      message: 'OPENAI_API_KEY is set in shell env (no codexx provider active to compare)'
    };
  }
  if (!shellKey && active) {
    return { name: 'shell_env_conflict', status: 'pass', message: 'no OPENAI_API_KEY in shell env (auth.json will be used)' };
  }
  try {
    const p = await readProvider(active);
    if (p.api_key === shellKey) {
      return {
        name: 'shell_env_conflict',
        status: 'pass',
        message: `shell OPENAI_API_KEY matches active provider '${active}'`
      };
    }
    return {
      name: 'shell_env_conflict',
      status: 'warn',
      message: `shell OPENAI_API_KEY differs from active provider '${active}' (shell wins for terminal codex)`,
      fix: 'unset OPENAI_API_KEY in the shell so auth.json is the source of truth'
    };
  } catch {
    return { name: 'shell_env_conflict', status: 'info', message: 'unable to read active provider metadata' };
  }
}

async function checkProjectLocalConfig(cwd) {
  // Project-local config means .codex/config.toml inside a repo (typically below $HOME).
  // The user-level config at $HOME/.codex/config.toml is NOT project-local.
  // Walk up from cwd toward project root, stopping at $HOME or filesystem root.
  const home = process.env.HOME || '';
  let dir = path.resolve(cwd);
  const findings = [];
  while (true) {
    if (home && path.resolve(dir) === path.resolve(home)) break;
    const candidate = path.join(dir, '.codex', 'config.toml');
    if (await exists(candidate)) findings.push(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (findings.length === 0) {
    return { name: 'project_local_config', status: 'pass', message: 'no project-local .codex/config.toml found' };
  }
  return {
    name: 'project_local_config',
    status: 'warn',
    message: `project-local config(s) detected: ${findings.join(', ')}`,
    fix: 'Project-local config overrides user-level settings for trusted projects'
  };
}

async function checkCredentialsStoreMode() {
  const p = codexConfigTomlPath();
  if (!(await exists(p))) {
    return { name: 'credentials_store', status: 'info', message: 'config.toml absent' };
  }
  try {
    const raw = await fsp.readFile(p, 'utf8');
    const parsed = parseToml(raw);
    const mode = parsed.cli_auth_credentials_store;
    if (!mode) {
      return { name: 'credentials_store', status: 'pass', message: 'cli_auth_credentials_store: default (auto)' };
    }
    if (mode === 'keyring') {
      return {
        name: 'credentials_store',
        status: 'warn',
        message: 'cli_auth_credentials_store = "keyring" — codexx writes auth.json which keyring mode may ignore',
        fix: 'Set cli_auth_credentials_store = "file" or "auto" for codexx-managed providers'
      };
    }
    return { name: 'credentials_store', status: 'pass', message: `cli_auth_credentials_store: ${mode}` };
  } catch (err) {
    return { name: 'credentials_store', status: 'fail', message: `config.toml unparseable: ${err.message}` };
  }
}

async function checkEnvFile() {
  const p = codexEnvFilePath();
  const active = await getCurrentProvider();
  if (!(await exists(p))) {
    if (!active) {
      return { name: 'env_file', status: 'info', message: 'no ~/.codex/.env (no active codexx provider)' };
    }
    return {
      name: 'env_file',
      status: 'warn',
      message: '~/.codex/.env missing but a codexx provider is active — Desktop App / GUI launches may fail with "Missing env var"',
      fix: 'Run codexx use <name> to (re)write ~/.codex/.env'
    };
  }
  const raw = await fsp.readFile(p, 'utf8');
  const hasBegin = raw.includes(ENV_MARKER_BEGIN);
  const hasEnd = raw.includes(ENV_MARKER_END);
  if (!hasBegin && !hasEnd) {
    if (active) {
      return {
        name: 'env_file',
        status: 'warn',
        message: '~/.codex/.env exists but contains no codexx-managed block',
        fix: 'Run codexx use <name> to inject OPENAI_API_KEY'
      };
    }
    return { name: 'env_file', status: 'pass', message: '~/.codex/.env present (user-managed, no codexx block)' };
  }
  if (hasBegin && hasEnd) {
    return { name: 'env_file', status: 'pass', message: '~/.codex/.env has intact codexx-managed block' };
  }
  return {
    name: 'env_file',
    status: 'fail',
    message: '~/.codex/.env has only one of BEGIN/END markers — section tampered',
    fix: 'Run codexx use <name> to repair'
  };
}

async function checkProviderInventory() {
  const names = await listProviders();
  if (names.length === 0) {
    return {
      name: 'provider_inventory',
      status: 'info',
      message: 'No codexx providers configured',
      fix: 'Run codexx add to add one'
    };
  }
  return {
    name: 'provider_inventory',
    status: 'pass',
    message: `${names.length} codexx provider(s) configured: ${names.join(', ')}`
  };
}

async function checkReviewCatalog() {
  const active = await getCurrentProvider();
  if (!active) {
    return {
      name: 'review_catalog',
      status: 'info',
      message: 'No active codexx provider; auto-review catalog check skipped'
    };
  }
  let provider;
  try {
    provider = await readProvider(active);
  } catch {
    return {
      name: 'review_catalog',
      status: 'info',
      message: 'Active provider metadata missing; auto-review catalog check skipped'
    };
  }

  const configPath = codexConfigTomlPath();
  if (!(await exists(configPath))) {
    return {
      name: 'review_catalog',
      status: 'warn',
      message: 'config.toml missing; cannot resolve auto-review catalog'
    };
  }

  let result;
  try {
    const configText = await fsp.readFile(configPath, 'utf8');
    result = await inspectReviewCatalog(configText, provider, { configTomlPath: configPath });
  } catch (err) {
    return {
      name: 'review_catalog',
      status: 'fail',
      message: `Auto-review catalog check failed: ${err.message}`
    };
  }

  if (result.status === 'not-configured') {
    return {
      name: 'review_catalog',
      status: 'info',
      message: 'model_catalog_json is not configured; auto-review catalog sync skipped'
    };
  }
  if (result.status === 'synced') {
    return {
      name: 'review_catalog',
      status: 'pass',
      message: `Auto-review model ${result.reviewModel} matches catalog override`,
      meta: { path: result.catalogPath, review_model: result.reviewModel }
    };
  }
  return {
    name: 'review_catalog',
    status: result.status === 'invalid' ? 'fail' : 'warn',
    message: `Auto-review catalog needs sync for ${result.reviewModel} (${result.status})`,
    fix: 'Run codexx use <active-provider>, or codexx sync-review <model>'
  };
}

/**
 * Format check results to a human-readable plain-text report.
 * For each check: a single line in the form  [STATUS]  name — message
 * followed by an indented `Fix: ...` line when present.
 */
export function formatDoctorReport(checks) {
  const out = [];
  for (const c of checks) {
    const tag = `[${c.status.toUpperCase().padEnd(4)}]`;
    out.push(`${tag} ${c.name} — ${c.message}`);
    if (c.fix) out.push(`        Fix: ${c.fix}`);
  }
  return out.join('\n') + '\n';
}

/**
 * Summarise overall status: returns 'pass' | 'warn' | 'fail'.
 * fail beats warn beats pass; info is neutral.
 */
export function summariseStatus(checks) {
  let worst = 'pass';
  for (const c of checks) {
    if (c.status === 'fail') return 'fail';
    if (c.status === 'warn' && worst === 'pass') worst = 'warn';
  }
  return worst;
}
