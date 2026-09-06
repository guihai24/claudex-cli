import path from 'node:path';
import fsp from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

import { t, knownLanguages } from './i18n.js';
import {
  codexHome,
  codexConfigTomlPath,
  codexAuthJsonPath,
  claudexAppDir,
  codexBackupsDir,
  codexSnapshotDir,
  codexCurrentProviderFile,
  codexAuditLogPath,
  codexLastKnownHashesPath,
  codexProvidersDir,
  isValidProviderName,
  isReservedProviderId,
  CLAUDEX_PROVIDER_PREFIX,
  LEGACY_AGENTS_MD_MARKER_BEGIN,
  LEGACY_AGENTS_MD_MARKER_END,
  codexAgentsMdPath,
  legacyCodexNativeStatePath
} from './constants.js';
import {
  exists,
  ensureDir
} from '../shared/fs-utils.js';
import {
  listProviders,
  readProvider,
  writeProvider,
  editProvider,
  removeProviderFile,
  getCurrentProvider,
  setCurrentProvider,
  resolveProviderArg,
  providerExists,
  normalizeBaseUrl
} from './providers.js';
import { scanSessions, formatSessionLine, parseSelection, buildResumeArgs } from './sessions.js';
import { applyProviderSwitch } from './apply-switch.js';
import { revertToPreClaudex, restoreBackup } from './revert.js';
import {
  ensurePreClaudexSnapshot,
  listBackups,
  readSnapshotManifest
} from './snapshot.js';
import { tailAuditLog } from './audit.js';
import { readAuthJson, inspectAuthJson } from './auth-json.js';
import { runDoctor, formatDoctorReport, summariseStatus } from './doctor.js';
import { inspectDrift, acceptExternalChanges } from './reconcile.js';
import { restoreChatGptTokens, findLatestChatGptBackup } from './restore-chatgpt.js';
import {
  detectCodex,
  detectCodexAppRunning,
  spawnCodex,
  sanitizedCodexEnv,
  buildLaunchBanner,
  preflight
} from './launch.js';
import { resolveCommand } from '../shared/resolve-launcher.js';

const PKG_VERSION = '0.1.0';

const CLAUDEX_OWNED = new Set([
  'init',
  'menu',
  'add',
  'list',
  'use',
  'edit',
  'remove',
  'test',
  'status',
  'doctor',
  'lang',
  'update',
  'snapshot',
  'restore',
  'revert',
  'audit',
  'reconcile',
  'restore-chatgpt',
  // codex commands we intercept with claudex-aware wrappers
  'login',
  'logout',
  'app'
]);

const HELP_FLAGS = new Set(['-h', '--help', 'help']);
const VERSION_FLAGS = new Set(['-v', '--version', 'version']);

// ----- entry -----

export async function main(argv = process.argv.slice(2)) {
  const lang = await getLanguageOrDefault();

  if (argv.length === 0) {
    // default codex launch
    return await runCodexDefault(lang);
  }

  const first = argv[0];

  if (first === '--') {
    return await passthroughCodex(argv.slice(1));
  }

  if (HELP_FLAGS.has(first)) {
    usage(lang);
    return 0;
  }
  if (VERSION_FLAGS.has(first)) {
    process.stdout.write(`codexx v${PKG_VERSION}\n`);
    return 0;
  }

  // `codexx --resume`: cross-provider session picker (enhancement). Distinct
  // from `codexx resume` (bare passthrough to codex's current-provider picker).
  // codex has no top-level --resume flag, so intercepting it collides with
  // nothing.
  if (first === '--resume') {
    return await cmdResumeAll(argv.slice(1), lang);
  }

  if (!CLAUDEX_OWNED.has(first)) {
    return await passthroughCodex(argv);
  }

  const sub = first;
  const rest = argv.slice(1);

  if (['init', 'menu', 'add', 'edit', 'list', 'use', 'remove', 'test', 'status', 'doctor', 'lang'].includes(sub) &&
      (rest.includes('--help') || rest.includes('-h'))) {
    usage(lang);
    return 0;
  }

  try {
    switch (sub) {
      case 'init':
        return await cmdInit(rest, lang);
      case 'menu':
        return await cmdMenu(rest, lang);
      case 'add':
        return await cmdAdd(rest, lang);
      case 'edit':
        return await cmdEdit(rest, lang);
      case 'list':
        return await cmdList(rest, lang);
      case 'use':
        return await cmdUse(rest, lang);
      case 'remove':
        return await cmdRemove(rest, lang);
      case 'test':
        return await cmdTest(rest, lang);
      case 'status':
        return await cmdStatus(rest, lang);
      case 'doctor':
        return await cmdDoctor(rest, lang);
      case 'lang':
        return await cmdLang(rest, lang);
      case 'update':
        return await cmdUpdate(rest, lang);
      case 'snapshot':
        return await cmdSnapshot(rest, lang);
      case 'restore':
        return await cmdRestore(rest, lang);
      case 'revert':
        return await cmdRevert(rest, lang);
      case 'audit':
        return await cmdAudit(rest, lang);
      case 'reconcile':
        return await cmdReconcile(rest, lang);
      case 'restore-chatgpt':
        return await cmdRestoreChatGpt(rest, lang);
      case 'login':
        return await cmdLogin(rest, lang);
      case 'logout':
        return await cmdLogout(rest, lang);
      case 'app':
        return await cmdApp(rest, lang);
      default:
        return await passthroughCodex(argv);
    }
  } catch (err) {
    process.stderr.write(`${t(lang, 'opFailed', { v: err.message || String(err) })}\n`);
    return 1;
  }
}

// ----- usage -----

function usage(lang) {
  const out = [];
  out.push(`codexx v${PKG_VERSION}`);
  out.push('');
  out.push(t(lang, 'usageHeader'));
  out.push('');
  out.push(t(lang, 'usageRun'));
  out.push('  codexx                          # spawn codex using the active provider');
  out.push('  codexx [<codex args>...]        # passthrough (e.g. codexx resume --last)');
  out.push('  codexx --resume [--include-subagents]  # pick a past session across ALL providers (this cwd; subagents hidden by default)');
  out.push('  codexx -- <args>                # force passthrough');
  out.push('');
  out.push(t(lang, 'usageMgmt'));
  out.push('  codexx init                     # initialise state dir + check codex install');
  out.push('  codexx menu                     # interactive menu');
  out.push('  codexx add [--test|--no-test|--no-input] # add provider via wizard');
  out.push('  codexx edit <name> [--model X --base-url U --api-key K --wire-api chat|responses --reasoning-effort low|medium|high]');
  out.push('  codexx list                     # list providers');
  out.push('  codexx use <name|index>         # switch active provider');
  out.push('  codexx remove <name|index> [--yes] [--no-input]');
  out.push('  codexx test [name|index]        # provider connectivity test');
  out.push('  codexx status                   # show active provider summary');
  out.push('  codexx lang <zh|en>             # set CLI language');
  out.push('');
  out.push(t(lang, 'usageDiag'));
  out.push('  codexx doctor [--json]          # diagnostics');
  out.push('  codexx snapshot                 # ensure pre-claudex snapshot');
  out.push('  codexx restore <id|latest>      # restore a previous backup');
  out.push('  codexx revert [--yes]           # restore pre-claudex state');
  out.push('  codexx audit [--tail N]         # view audit log');
  out.push('  codexx reconcile [--yes]        # accept external edits as new baseline');
  out.push('  codexx restore-chatgpt [--yes]  # restore ChatGPT OAuth tokens from backup');
  out.push('  codexx update                   # self-update');
  out.push('');
  out.push(t(lang, 'usageEsc'));
  out.push('  codexx login / logout / app     # claudex-aware codex wrappers');
  out.push('  codexx resume / fork / exec / review / apply / mcp / plugin / features ...');
  out.push('  CODEXX_API_KEY=... codexx add ... # avoid putting the key in shell history');
  process.stdout.write(out.join('\n') + '\n');
}

// ----- language -----

function languageFilePath() {
  return path.join(claudexAppDir(), 'language');
}

async function getLanguageOrDefault() {
  const file = languageFilePath();
  if (await exists(file)) {
    const v = (await fsp.readFile(file, 'utf8')).trim().toLowerCase();
    if (knownLanguages().includes(v)) return v;
  }
  return 'zh';
}

function normalizeLanguage(input) {
  const v = (input || '').trim().toLowerCase();
  if (v === 'zh' || v === 'cn' || v === 'zh-cn' || v === 'chinese' || v === '中文') return 'zh';
  if (v === 'en' || v === 'en-us' || v === 'english' || v === '英文') return 'en';
  return '';
}

async function cmdLang(args, lang) {
  if (args.length === 0) {
    process.stdout.write(`${await getLanguageOrDefault()}\n`);
    return 0;
  }
  const v = normalizeLanguage(args[0]);
  if (!v) {
    process.stderr.write(t(lang, 'invalidArg', { v: args[0] }) + '\n');
    return 2;
  }
  await ensureDir(claudexAppDir());
  await fsp.writeFile(languageFilePath(), v + '\n', 'utf8');
  process.stdout.write(`language: ${v}\n`);
  return 0;
}

// ----- init -----

async function cmdInit(args, lang) {
  await ensureDir(claudexAppDir());
  await ensureDir(codexProvidersDir());
  await ensureDir(codexBackupsDir());

  // One-shot migration: remove leftover codexx Native artifacts from older versions.
  const scrubbed = await scrubLegacyNativeArtifacts();
  if (scrubbed.agentsCleaned) {
    process.stdout.write(t(lang, 'legacyNativeAgentsCleaned') + '\n');
  }
  if (scrubbed.stateRemoved) {
    process.stdout.write(t(lang, 'legacyNativeStateRemoved') + '\n');
  }

  const codex = detectCodex();
  if (!codex.installed) {
    process.stderr.write(t(lang, 'codexNotInstalled') + '\n');
    return 1;
  }
  if (codex.version) {
    const major = parseInt(codex.version.split('.')[1] || '0', 10);
    if (major < 130) {
      process.stdout.write(t(lang, 'codexOldVersion', { v: codex.version }) + '\n');
    }
  }
  process.stdout.write(t(lang, 'initOk') + '\n');
  process.stdout.write(t(lang, 'codexCliVersion', { v: codex.version || 'unknown' }) + '\n');
  return 0;
}

/**
 * Remove leftover AGENTS.md native blocks + codex-native.json from older codexx
 * versions that still had the Native feature. Pure cleanup; never injects.
 */
async function scrubLegacyNativeArtifacts() {
  let agentsCleaned = false;
  let stateRemoved = false;

  const agentsPath = codexAgentsMdPath();
  if (await exists(agentsPath)) {
    const raw = await fsp.readFile(agentsPath, 'utf8');
    if (raw.includes(LEGACY_AGENTS_MD_MARKER_BEGIN) || raw.includes(LEGACY_AGENTS_MD_MARKER_END)) {
      const cleaned = removeLegacyAgentsBlock(raw);
      if (cleaned !== raw) {
        await fsp.writeFile(agentsPath, cleaned, 'utf8');
        agentsCleaned = true;
      }
    }
  }

  const statePath = legacyCodexNativeStatePath();
  if (await exists(statePath)) {
    await fsp.unlink(statePath);
    stateRemoved = true;
  }

  return { agentsCleaned, stateRemoved };
}

/** Pure: strip the legacy BEGIN…END block (and one surrounding blank line). */
export function removeLegacyAgentsBlock(raw) {
  const beginIdx = raw.indexOf(LEGACY_AGENTS_MD_MARKER_BEGIN);
  if (beginIdx === -1) {
    // Only END present — leave as-is rather than guess.
    return raw;
  }
  const endIdx = raw.indexOf(LEGACY_AGENTS_MD_MARKER_END, beginIdx);
  if (endIdx === -1) {
    // Dangling BEGIN — drop from BEGIN to EOF (safer than leaving a broken marker).
    let removeStart = beginIdx;
    if (removeStart >= 2 && raw.slice(removeStart - 2, removeStart) === '\n\n') {
      removeStart -= 1;
    }
    return raw.slice(0, removeStart).replace(/\n+$/, '\n');
  }
  let removeStart = beginIdx;
  if (removeStart >= 2 && raw.slice(removeStart - 2, removeStart) === '\n\n') {
    removeStart -= 1;
  }
  let removeEnd = endIdx + LEGACY_AGENTS_MD_MARKER_END.length;
  if (raw[removeEnd] === '\n') removeEnd += 1;
  return raw.slice(0, removeStart) + raw.slice(removeEnd);
}

// ----- list -----

async function cmdList(args, lang) {
  const names = await listProviders();
  if (names.length === 0) {
    process.stdout.write(t(lang, 'providersEmpty') + '\n');
    return 0;
  }
  const active = await getCurrentProvider();
  process.stdout.write(t(lang, 'providersHeader') + '\n');
  names.forEach((n, i) => {
    const mark = n === active ? t(lang, 'activeMark') : '';
    process.stdout.write(`  ${i + 1}. ${n}${mark}\n`);
  });
  return 0;
}

// ----- status -----

async function cmdStatus(args, lang) {
  const active = await getCurrentProvider();
  if (!active) {
    process.stdout.write(t(lang, 'noActiveProvider') + '\n');
  } else {
    process.stdout.write(t(lang, 'currentProvider', { v: active }) + '\n');
    try {
      const p = await readProvider(active);
      process.stdout.write(t(lang, 'currentEndpoint', { v: p.base_url }) + '\n');
      process.stdout.write(t(lang, 'currentModel', { v: p.model }) + '\n');
      process.stdout.write(t(lang, 'currentWireApi', { v: p.wire_api || 'responses' }) + '\n');
    } catch {
      process.stdout.write(t(lang, 'providerMissing', { v: active }) + '\n');
    }
  }

  const auth = await readAuthJson();
  const inspect = inspectAuthJson(auth);
  if (inspect.present) {
    const mode = inspect.hasChatGptTokens
      ? `chatgpt (OAuth)`
      : (inspect.claudexManaged ? `${inspect.authMode || 'apikey'} (claudex managed)` : (inspect.authMode || 'unknown'));
    process.stdout.write(t(lang, 'currentAuthMode', { v: mode }) + '\n');
  }

  const codex = detectCodex();
  if (codex.installed) {
    process.stdout.write(t(lang, 'codexCliVersion', { v: codex.version || 'unknown' }) + '\n');
  } else {
    process.stdout.write(t(lang, 'codexCliMissing') + '\n');
  }
  const app = detectCodexAppRunning();
  if (app !== null) {
    if (app.running) {
      process.stdout.write(t(lang, 'codexAppRunning', { v: app.pid }) + '\n');
    } else {
      process.stdout.write(t(lang, 'codexAppNotRunning') + '\n');
    }
  }
  return 0;
}

// ----- add -----

async function cmdAdd(args, lang) {
  const flags = parseFlags(args);
  const provider = {
    name: flags.name,
    base_url: flags['base-url'] || flags.baseUrl,
    api_key: flags['api-key'] || flags.apiKey || process.env.CODEXX_API_KEY,
    model: flags.model,
    wire_api: flags['wire-api'] || flags.wireApi || 'responses',
    model_reasoning_effort: flags['reasoning-effort'] || flags.reasoningEffort || 'high'
  };

  const allRequiredFromFlags = provider.name && provider.base_url && provider.api_key && provider.model;
  const interactive = process.stdin.isTTY === true && flags['no-input'] !== true;

  if (!allRequiredFromFlags) {
    if (!interactive) {
      const missing = ['name', 'base_url', 'api_key', 'model'].filter((k) => !provider[k.replace('_url', '-url').replace('_key', '-key')] && !provider[k.replace(/_/g, '')] && !provider[k]);
      // Compute missing required by direct key checks
      const realMissing = [];
      if (!provider.name) realMissing.push('--name');
      if (!provider.base_url) realMissing.push('--base-url');
      if (!provider.api_key) realMissing.push('--api-key');
      if (!provider.model) realMissing.push('--model');
      process.stderr.write(t(lang, 'missingArg', { v: realMissing.join(', ') }) + '\n');
      return 2;
    }
    const rl = readline.createInterface({ input, output });
    try {
      if (!provider.name) provider.name = (await rl.question(t(lang, 'askName'))).trim();
      if (!provider.base_url) provider.base_url = (await rl.question(t(lang, 'askBaseUrl'))).trim();
      if (!provider.api_key) provider.api_key = (await rl.question(t(lang, 'askApiKey'))).trim();
      if (!provider.model) provider.model = (await rl.question(t(lang, 'askModel'))).trim();
      if (!flags['wire-api'] && !flags.wireApi) {
        const w = (await rl.question(t(lang, 'askWireApi'))).trim();
        if (w) provider.wire_api = w;
      }
      if (!provider.model_reasoning_effort) {
        const r = (await rl.question(t(lang, 'askReasoning'))).trim();
        if (r) provider.model_reasoning_effort = r;
      }
    } finally {
      rl.close();
    }
  }

  // Drop empty optional fields
  if (!provider.model_reasoning_effort) delete provider.model_reasoning_effort;

  // Normalise base_url: append /v1 if user gave just a bare domain.
  // Tell the user what we changed so the normalisation isn't silent.
  if (provider.base_url) {
    const original = provider.base_url;
    provider.base_url = normalizeBaseUrl(provider.base_url);
    if (original !== provider.base_url) {
      process.stdout.write(`ℹ️ base_url normalised: ${original} → ${provider.base_url}\n`);
    }
  }

  try {
    await writeProvider(provider);
  } catch (err) {
    process.stderr.write(t(lang, 'opFailed', { v: err.message }) + '\n');
    return 2;
  }
  process.stdout.write(t(lang, 'addedOk', { v: provider.name }) + '\n');
  const testCode = await maybeTestAfterAdd(provider, flags, lang);
  if (testCode === 0) process.stdout.write(`codexx use ${provider.name}\n`);
  return testCode;
}

// ----- edit -----

function maskApiKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '(not set)';
  if (key.length <= 10) return key.slice(0, 3) + '***';
  return key.slice(0, 7) + '...' + key.slice(-4);
}

async function cmdEdit(args, lang) {
  const flags = parseFlags(args);
  if (flags._.length === 0) {
    process.stderr.write(t(lang, 'missingArg', { v: 'name' }) + '\n');
    return 2;
  }
  const name = await resolveProviderArg(flags._[0]);
  const current = await readProvider(name);

  const fieldMap = {
    'base-url': 'base_url',
    'baseUrl': 'base_url',
    'api-key': 'api_key',
    'apiKey': 'api_key',
    'model': 'model',
    'wire-api': 'wire_api',
    'wireApi': 'wire_api',
    'reasoning-effort': 'model_reasoning_effort',
    'reasoningEffort': 'model_reasoning_effort'
  };
  const updates = {};
  for (const [flagKey, field] of Object.entries(fieldMap)) {
    if (flagKey in flags && typeof flags[flagKey] === 'string') {
      updates[field] = flags[flagKey];
    }
  }

  const interactive = process.stdin.isTTY === true && flags['no-input'] !== true;
  if (Object.keys(updates).length === 0) {
    if (!interactive) {
      process.stderr.write(
        t(lang, 'missingArg', { v: '--base-url / --api-key / --model / --wire-api / --reasoning-effort 至少一个' }) + '\n'
      );
      return 2;
    }
    process.stdout.write(t(lang, 'editIntro', { v: name }) + '\n');
    const rl = readline.createInterface({ input, output });
    try {
      const askField = async (field, currentValue, label, hint) => {
        const shown = field === 'api_key' ? maskApiKey(currentValue) : (currentValue || t(lang, 'editUnset'));
        process.stdout.write(`  ${label} ${t(lang, 'editCurrent')}: ${shown}\n`);
        const next = (await rl.question(`  ${t(lang, 'editNewOrKeep', { hint: hint ? ', ' + hint : '' })}: `)).trim();
        if (next.length > 0) updates[field] = next;
      };
      await askField('base_url', current.base_url, 'base_url', '');
      await askField('api_key', current.api_key, 'api_key', '');
      await askField('model', current.model, 'model', '');
      await askField('wire_api', current.wire_api, 'wire_api', 'chat / responses');
      await askField('model_reasoning_effort', current.model_reasoning_effort, 'reasoning_effort', 'low / medium / high');
    } finally {
      rl.close();
    }
  }

  if (Object.keys(updates).length === 0) {
    process.stdout.write(t(lang, 'editNoChanges') + '\n');
    return 0;
  }

  if (typeof updates.base_url === 'string') {
    const normed = normalizeBaseUrl(updates.base_url);
    if (normed !== updates.base_url) {
      process.stdout.write(`ℹ️ base_url normalised: ${updates.base_url} → ${normed}\n`);
      updates.base_url = normed;
    }
  }

  let merged;
  try {
    merged = await editProvider(name, updates);
  } catch (err) {
    process.stderr.write(t(lang, 'opFailed', { v: err.message }) + '\n');
    return 2;
  }
  process.stdout.write(t(lang, 'editedOk', { v: name, fields: Object.keys(updates).join(', ') }) + '\n');

  const active = await getCurrentProvider();
  if (active === name) {
    process.stdout.write(t(lang, 'editReapplying') + '\n');
    try {
      await applyProviderSwitch(merged, {
        previousProvider: name,
        onDrift: () => true
      });
      process.stdout.write(t(lang, 'editReapplied') + '\n');
    } catch (err) {
      process.stderr.write(t(lang, 'opFailed', { v: err.message }) + '\n');
      return 1;
    }
  } else {
    process.stdout.write(t(lang, 'editNotActiveHint', { v: name }) + '\n');
  }
  return 0;
}

// ----- remove -----

async function cmdRemove(args, lang) {
  const flags = parseFlags(args);
  if (flags._.length === 0) {
    process.stderr.write(t(lang, 'missingArg', { v: 'name' }) + '\n');
    return 2;
  }
  const name = await resolveProviderArg(flags._[0]);
  const active = await getCurrentProvider();
  if (name === active) {
    process.stderr.write(t(lang, 'removeActive') + '\n');
    return 2;
  }
  if (!flags.yes) {
    if (process.stdin.isTTY !== true || flags['no-input'] === true) {
      process.stderr.write(t(lang, 'nonInteractiveRequiresYes') + '\n');
      return 2;
    }
    const rl = readline.createInterface({ input, output });
    let ans;
    try {
      ans = (await rl.question(t(lang, 'removeConfirm', { v: name }))).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (ans !== 'y' && ans !== 'yes') {
      process.stdout.write(t(lang, 'canceled') + '\n');
      return 0;
    }
  }
  await removeProviderFile(name);
  process.stdout.write(t(lang, 'removedOk', { v: name }) + '\n');
  return 0;
}

// ----- use -----

async function cmdUse(args, lang) {
  const flags = parseFlags(args);
  if (flags._.length === 0) {
    process.stderr.write(t(lang, 'missingArg', { v: 'name' }) + '\n');
    return 2;
  }
  const name = await resolveProviderArg(flags._[0]);
  const provider = await readProvider(name);
  const previousProvider = await getCurrentProvider();

  const onDrift = async (drift) => {
    if (flags.force) return true;
    process.stdout.write(t(lang, 'driftDetected', { v: drift.driftedFiles.join(', ') }) + '\n');
    if (process.stdin.isTTY !== true || flags['no-input'] === true) {
      process.stderr.write(t(lang, 'driftNonInteractive') + '\n');
      return false;
    }
    const rl = readline.createInterface({ input, output });
    let ans;
    try {
      ans = (await rl.question(t(lang, 'driftPrompt'))).trim().toLowerCase();
    } finally {
      rl.close();
    }
    return ans === 'y' || ans === 'yes';
  };

  const result = await applyProviderSwitch(provider, {
    previousProvider,
    onDrift
  });

  process.stdout.write(t(lang, 'switchedTo', { v: provider.name }) + '\n');
  process.stdout.write(t(lang, 'switchEndpoint', { v: provider.base_url }) + '\n');
  process.stdout.write(t(lang, 'switchModel', { v: provider.model }) + '\n');
  process.stdout.write(t(lang, 'backupAt', { v: result.backupDir }) + '\n');
  if (result.chatgptBackupPath) {
    process.stdout.write(t(lang, 'chatgptBackupAt', { v: result.chatgptBackupPath }) + '\n');
    process.stdout.write(t(lang, 'chatgptRestoreHint') + '\n');
  }
  const app = detectCodexAppRunning();
  if (app && app.running) {
    process.stdout.write(t(lang, 'restartCodexHint') + '\n');
  }
  return 0;
}

// ----- test -----

/**
 * Decide whether to run a connectivity probe after a successful `add`.
 * - --no-test always skips
 * - --test always runs (including non-interactive)
 * - interactive TTY asks (default Y), same as claudex
 * - non-interactive without flags skips (don't hang scripts)
 */
export function decidePostAddTest({ interactive, forceTest, forceNoTest }) {
  if (forceNoTest) return 'skip';
  if (forceTest) return 'run';
  if (interactive) return 'ask';
  return 'skip';
}

/** Empty / y / yes / 是 / ok → run (default yes). */
export function shouldRunTestInput(ansRaw) {
  const ans = (ansRaw || '').trim().toLowerCase();
  return ans === '' || ans === 'y' || ans === 'yes' || ans === '是' || ans === 'ok';
}

export function isSuccessfulHttpStatus(status) {
  return status >= 200 && status < 300;
}

async function reportProbeResult(name, result, lang) {
  if (result.ok) {
    process.stdout.write(
      t(lang, 'testOk', {
        v: name,
        status: result.status,
        protocol: result.protocol,
        ms: result.ms
      }) + '\n'
    );
    return 0;
  }
  // Build a useful failure reason. If the provider returned a body, include the
  // first 200 chars; if it returned nothing, surface at least the HTTP status
  // (or network error) so the user has something to act on.
  let reason = (result.reason && result.reason.trim().length > 0) ? result.reason.trim() : null;
  if (!reason) {
    reason = result.status > 0
      ? `HTTP ${result.status} (empty body)`
      : 'network error / unreachable';
  }
  process.stderr.write(t(lang, 'testFail', { v: name, reason }) + '\n');
  return 1;
}

async function maybeTestAfterAdd(provider, flags, lang) {
  const decision = decidePostAddTest({
    interactive: process.stdin.isTTY === true,
    forceTest: flags.test === true,
    forceNoTest: flags['no-test'] === true || flags.noTest === true
  });
  if (decision === 'skip') return 0;
  if (decision === 'ask') {
    const rl = readline.createInterface({ input, output });
    let ans = '';
    try {
      ans = await rl.question(t(lang, 'testNowQ'));
    } finally {
      rl.close();
    }
    if (!shouldRunTestInput(ans)) return 0;
  }
  process.stdout.write(t(lang, 'testRunning', { v: provider.name }) + '\n');
  const result = await probeProvider(provider);
  return await reportProbeResult(provider.name, result, lang);
}

async function cmdTest(args, lang) {
  const flags = parseFlags(args);
  let name;
  if (flags._.length === 0) {
    name = await getCurrentProvider();
    if (!name) {
      process.stderr.write(t(lang, 'noActiveProvider') + '\n');
      return 2;
    }
  } else {
    name = await resolveProviderArg(flags._[0]);
  }
  const provider = await readProvider(name);
  process.stdout.write(t(lang, 'testRunning', { v: name }) + '\n');
  const result = await probeProvider(provider);
  return await reportProbeResult(name, result, lang);
}

async function probeProvider(provider) {
  const wire = provider.wire_api || 'responses';
  const url = new URL(
    wire === 'responses' ? '/v1/responses' : '/v1/chat/completions',
    provider.base_url.endsWith('/') ? provider.base_url : provider.base_url + '/'
  );
  // Use a tiny body; only a 2xx response proves this provider is usable.
  const body = JSON.stringify(
    wire === 'responses'
      ? { model: provider.model, input: 'ping', max_output_tokens: 1 }
      : {
          model: provider.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        }
  );
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + (url.search || ''),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.api_key}`,
          'Content-Length': Buffer.byteLength(body).toString()
        },
        timeout: 8000
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const ms = Date.now() - startedAt;
          const ok = isSuccessfulHttpStatus(res.statusCode);
          resolve({
            ok,
            status: res.statusCode,
            ms,
            protocol: wire,
            reason: ok ? null : Buffer.concat(chunks).toString().slice(0, 200)
          });
        });
      }
    );
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, ms: Date.now() - startedAt, protocol: wire, reason: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, ms: Date.now() - startedAt, protocol: wire, reason: 'timeout' });
    });
    req.write(body);
    req.end();
  });
}

// ----- snapshot / restore / revert / audit -----

async function cmdSnapshot(args, lang) {
  const r = await ensurePreClaudexSnapshot();
  if (r.taken) process.stdout.write(t(lang, 'snapshotTaken', { v: r.dir }) + '\n');
  else process.stdout.write(t(lang, 'snapshotExisted') + '\n');
  return 0;
}

async function cmdRestore(args, lang) {
  const flags = parseFlags(args);
  const id = flags._[0] || 'latest';
  // Resolve the target up front so the prompt names the actual backup and
  // an incomplete/missing id fails before the user is asked anything.
  const backups = await listBackups();
  const target = id === 'latest'
    ? backups.find((b) => b.complete)
    : backups.find((b) => b.id === id);
  if (!target || !target.complete) {
    // restoreBackup throws the precise message; reuse it.
    await restoreBackup(id);
    return 1;
  }
  if (!flags.yes) {
    const rl = readline.createInterface({ input, output });
    let ans;
    try {
      ans = (await rl.question(t(lang, 'restoreConfirm', { v: target.id }))).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (ans !== 'y' && ans !== 'yes') {
      process.stdout.write(t(lang, 'canceled') + '\n');
      return 0;
    }
  }
  const result = await restoreBackup(target.id);
  process.stdout.write(t(lang, 'restoreOk', { v: result.id }) + '\n');
  return 0;
}

async function cmdRevert(args, lang) {
  const flags = parseFlags(args);
  const manifest = await readSnapshotManifest();
  if (!manifest) {
    process.stderr.write(t(lang, 'revertNoSnapshot') + '\n');
    return 1;
  }
  if (!flags.yes) {
    const rl = readline.createInterface({ input, output });
    let ans;
    try {
      ans = (await rl.question(t(lang, 'revertConfirm'))).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (ans !== 'y' && ans !== 'yes') {
      process.stdout.write(t(lang, 'canceled') + '\n');
      return 0;
    }
  }
  await revertToPreClaudex({
    removeStateFiles: true,
    preserveBackups: flags['preserve-backups'] !== false
  });
  process.stdout.write(t(lang, 'revertedOk') + '\n');
  return 0;
}

async function cmdAudit(args, lang) {
  const flags = parseFlags(args);
  const n = parseInt(flags.tail || '20', 10);
  const events = await tailAuditLog(n);
  if (events.length === 0) {
    process.stdout.write(t(lang, 'auditEmpty') + '\n');
    return 0;
  }
  process.stdout.write(t(lang, 'auditHeader', { v: events.length }) + '\n');
  for (const ev of events) {
    process.stdout.write(JSON.stringify(ev) + '\n');
  }
  return 0;
}

// ----- stubs (M4/M5) -----

async function cmdDoctor(args, lang) {
  const flags = parseFlags(args);
  const checks = await runDoctor({
    cwd: process.cwd(),
    provider: flags.provider
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ checks, summary: summariseStatus(checks) }, null, 2) + '\n');
  } else {
    process.stdout.write(formatDoctorReport(checks));
    process.stdout.write(`Summary: ${summariseStatus(checks).toUpperCase()}\n`);
  }
  const summary = summariseStatus(checks);
  if (summary === 'fail') return 1;
  return 0;
}

async function cmdMenu(args, lang) {
  while (true) {
    process.stdout.write(`\n${t(lang, 'menuTitle')}\n`);
    process.stdout.write('----------------------------------------\n');
    for (const k of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']) {
      process.stdout.write(t(lang, k) + '\n');
    }
    process.stdout.write('----------------------------------------\n');
    const rl = readline.createInterface({ input, output });
    let choice;
    try {
      choice = (await rl.question(t(lang, 'menuChoose'))).trim();
    } finally {
      rl.close();
    }
    try {
      if (choice === '1') {
        await cmdAdd([], lang);
        continue;
      }
      if (choice === '2') {
        await cmdStatus([], lang);
        continue;
      }
      if (choice === '3') {
        const names = await listProviders();
        if (names.length === 0) {
          process.stdout.write(t(lang, 'providersEmpty') + '\n');
          continue;
        }
        process.stdout.write(t(lang, 'providersHeader') + '\n');
        names.forEach((n, i) => process.stdout.write(`  ${i + 1}. ${n}\n`));
        const rl2 = readline.createInterface({ input, output });
        let pick;
        try {
          pick = (await rl2.question(t(lang, 'askSwitchTo') || 'name or index: ')).trim();
        } finally {
          rl2.close();
        }
        if (pick) await cmdUse([pick], lang);
        continue;
      }
      if (choice === '4') {
        await manageProvidersMenu(lang);
        continue;
      }
      if (choice === '5') {
        await cmdDoctor([], lang);
        continue;
      }
      if (choice === '6') {
        await moreSettingsMenu(lang);
        continue;
      }
      if (choice === '7' || choice.toLowerCase() === 'q') {
        process.stdout.write(t(lang, 'bye') + '\n');
        return 0;
      }
      process.stdout.write(t(lang, 'menuInvalid') + '\n');
    } catch (err) {
      process.stderr.write(`${t(lang, 'opFailed', { v: err.message || String(err) })}\n`);
    }
  }
}

async function manageProvidersMenu(lang) {
  while (true) {
    process.stdout.write('\n');
    for (const k of ['mmg1', 'mmg2', 'mmg3', 'mmg4', 'mmg5']) {
      process.stdout.write(t(lang, k) + '\n');
    }
    const rl = readline.createInterface({ input, output });
    let choice;
    try {
      choice = (await rl.question(t(lang, 'mmgChoose'))).trim();
    } finally {
      rl.close();
    }
    // Order aligned with claudex: list → add → edit → remove → back
    if (choice === '1') {
      await cmdList([], lang);
      continue;
    }
    if (choice === '2') {
      await cmdAdd([], lang);
      continue;
    }
    if (choice === '3') {
      const names = await listProviders();
      if (names.length === 0) {
        process.stdout.write(t(lang, 'providersEmpty') + '\n');
        continue;
      }
      process.stdout.write(t(lang, 'providersHeader') + '\n');
      names.forEach((n, i) => process.stdout.write(`  ${i + 1}. ${n}\n`));
      const rl2 = readline.createInterface({ input, output });
      let pick;
      try {
        pick = (await rl2.question(t(lang, 'editPickPrompt'))).trim();
      } finally {
        rl2.close();
      }
      if (pick) await cmdEdit([pick], lang);
      continue;
    }
    if (choice === '4') {
      const names = await listProviders();
      if (names.length === 0) {
        process.stdout.write(t(lang, 'providersEmpty') + '\n');
        continue;
      }
      process.stdout.write(t(lang, 'providersHeader') + '\n');
      names.forEach((n, i) => process.stdout.write(`  ${i + 1}. ${n}\n`));
      const rl2 = readline.createInterface({ input, output });
      let pick;
      try {
        pick = (await rl2.question(t(lang, 'removePickPrompt'))).trim();
      } finally {
        rl2.close();
      }
      if (pick) await cmdRemove([pick], lang);
      continue;
    }
    if (choice === '5') return;
    process.stdout.write(t(lang, 'mmgInvalid') + '\n');
  }
}

async function moreSettingsMenu(lang) {
  while (true) {
    process.stdout.write('\n');
    for (const k of ['more1', 'more2', 'more3']) {
      process.stdout.write(t(lang, k) + '\n');
    }
    const rl = readline.createInterface({ input, output });
    let choice;
    try {
      choice = (await rl.question(t(lang, 'moreChoose'))).trim();
    } finally {
      rl.close();
    }
    if (choice === '1') {
      const rl2 = readline.createInterface({ input, output });
      let pick;
      try {
        pick = (await rl2.question(t(lang, 'langPrompt'))).trim();
      } finally {
        rl2.close();
      }
      if (pick) await cmdLang([pick], lang);
      continue;
    }
    if (choice === '2') {
      await cmdInit([], lang);
      continue;
    }
    if (choice === '3') return;
    process.stdout.write(t(lang, 'moreInvalid') + '\n');
  }
}

async function cmdReconcile(args, lang) {
  const flags = parseFlags(args);
  const inspection = await inspectDrift();
  if (!inspection.baseline) {
    process.stdout.write('No codexx baseline yet — nothing to reconcile.\n');
    return 0;
  }
  const driftedFiles = [];
  if (inspection.drift.config) driftedFiles.push('config.toml');
  if (inspection.drift.auth) driftedFiles.push('auth.json');
  if (driftedFiles.length === 0) {
    process.stdout.write('No drift detected. State matches last codexx baseline.\n');
    return 0;
  }
  process.stdout.write(`Drift detected in: ${driftedFiles.join(', ')}\n`);
  for (const file of driftedFiles) {
    const d = file === 'config.toml' ? inspection.drift.config : inspection.drift.auth;
    process.stdout.write(`  ${file}: ${d.before?.slice(0, 12) || 'null'} → ${d.after?.slice(0, 12) || 'null'}\n`);
  }
  if (!flags.yes) {
    const rl = readline.createInterface({ input, output });
    let ans;
    try {
      ans = (await rl.question('Accept external changes as new baseline? [y/N]: ')).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (ans !== 'y' && ans !== 'yes') {
      process.stdout.write(t(lang, 'canceled') + '\n');
      return 0;
    }
  }
  await acceptExternalChanges();
  process.stdout.write('✅ Baseline updated to current state.\n');
  return 0;
}

async function cmdRestoreChatGpt(args, lang) {
  const found = await findLatestChatGptBackup();
  if (!found) {
    process.stderr.write('⚠️ No ChatGPT tokens backup found in codex-backups/.\n');
    return 1;
  }
  process.stdout.write(`Found ChatGPT tokens backup: ${found.backupId}\n`);
  const flags = parseFlags(args);
  if (!flags.yes) {
    const rl = readline.createInterface({ input, output });
    let ans;
    try {
      ans = (await rl.question('Restore ChatGPT OAuth tokens to ~/.codex/auth.json (overwriting current)? [y/N]: ')).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (ans !== 'y' && ans !== 'yes') {
      process.stdout.write(t(lang, 'canceled') + '\n');
      return 0;
    }
  }
  const result = await restoreChatGptTokens();
  process.stdout.write(`✅ ChatGPT OAuth tokens restored from backup ${result.backupId}\n`);
  return 0;
}

async function cmdUpdate(args, lang) {
  // self-update via npm; reuse pattern from claudex `claudex update`.
  const { spawn } = await import('node:child_process');
  const { file, prefixArgs, shell } = resolveCommand('npm');
  return await new Promise((resolve) => {
    const spawnOpts = shell ? { stdio: 'inherit', shell: true } : { stdio: 'inherit' };
    const child = spawn(
      file,
      [...prefixArgs, 'install', '-g', 'git+https://github.com/huaguihai/claudex-cli.git#main'],
      spawnOpts
    );
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      process.stderr.write(`${t(lang, 'opFailed', { v: err.message })}\n`);
      resolve(1);
    });
  });
}

// ----- login / logout / app wrappers -----

async function cmdLogin(args, lang) {
  // Help-flag passthrough — never show warnings on `--help`
  if (args.includes('--help') || args.includes('-h')) {
    return await spawnCodex(['login', ...args]);
  }
  const auth = await readAuthJson();
  const inspect = inspectAuthJson(auth);
  if (inspect.present && (inspect.claudexManaged || inspect.hasChatGptTokens)) {
    process.stdout.write(t(lang, 'loginWarnOAuth') + '\n');
    if (inspect.claudexManaged) {
      process.stdout.write(`   current claudex provider: ${inspect.claudexProvider}\n`);
    }
    if (!args.includes('--yes') && !args.includes('-y')) {
      const rl = readline.createInterface({ input, output });
      let ans;
      try {
        ans = (await rl.question(t(lang, 'loginContinue'))).trim().toLowerCase();
      } finally {
        rl.close();
      }
      if (ans !== 'y' && ans !== 'yes') {
        process.stdout.write(t(lang, 'canceled') + '\n');
        return 0;
      }
    }
  }
  // Strip the --yes flag (codex login doesn't know it) and passthrough
  const codexArgs = args.filter((a) => a !== '--yes' && a !== '-y');
  return await spawnCodex(['login', ...codexArgs]);
}

async function cmdLogout(args, lang) {
  if (args.includes('--help') || args.includes('-h')) {
    return await spawnCodex(['logout', ...args]);
  }
  const auth = await readAuthJson();
  const inspect = inspectAuthJson(auth);
  if (inspect.present && inspect.claudexManaged) {
    process.stdout.write(t(lang, 'logoutWarnClaudex') + '\n');
    process.stdout.write(`   current claudex provider: ${inspect.claudexProvider}\n`);
    if (!args.includes('--yes') && !args.includes('-y')) {
      const rl = readline.createInterface({ input, output });
      let ans;
      try {
        ans = (await rl.question(t(lang, 'logoutContinue'))).trim().toLowerCase();
      } finally {
        rl.close();
      }
      if (ans !== 'y' && ans !== 'yes') {
        process.stdout.write(t(lang, 'canceled') + '\n');
        return 0;
      }
    }
  }
  const codexArgs = args.filter((a) => a !== '--yes' && a !== '-y');
  return await spawnCodex(['logout', ...codexArgs]);
}

async function cmdApp(args, lang) {
  if (args.includes('--help') || args.includes('-h')) {
    return await spawnCodex(['app', ...args]);
  }
  const active = await getCurrentProvider();
  if (active) {
    try {
      const p = await readProvider(active);
      const banner = buildLaunchBanner(p);
      if (banner && !process.env.CODEXX_QUIET) process.stderr.write(banner + '\n');
    } catch {
      // ignore
    }
  }
  process.stdout.write(t(lang, 'appLaunching') + '\n');
  return await spawnCodex(['app', ...args]);
}

// ----- default + passthrough -----

async function runCodexDefault(lang) {
  const pre = await preflight();
  if (!pre.ok) {
    process.stderr.write(`${t(lang, 'opFailed', { v: pre.error })}\n`);
    return 1;
  }
  const active = await getCurrentProvider();
  if (active) {
    try {
      const provider = await readProvider(active);
      const banner = buildLaunchBanner(provider);
      if (banner && !process.env.CODEXX_QUIET) {
        process.stderr.write(banner + '\n');
      }
    } catch {
      // ignore
    }
  }
  for (const w of pre.warnings) process.stderr.write(`ℹ️ ${w}\n`);
  return await spawnCodex([]);
}

async function passthroughCodex(args) {
  return await spawnCodex(args);
}

// ----- cross-provider resume (codexx --resume) -----

// `codexx resume` stays a pure passthrough to codex's own picker, which only
// shows sessions for the active provider. `codexx --resume` is the
// enhancement: list THIS cwd's sessions across ALL providers, then hand the
// chosen id to `codex resume`, pinned to the current active provider via
// `-c model_provider=...`. The explicit pin matters: codex ≥0.144 otherwise
// restores the session's original provider from the rollout, which combines
// the OLD provider's base_url with the ACTIVE provider's injected key → 401
// (see buildResumeArgs). Sessions follow the switcher, not the provider they
// were born on — otherwise a dead provider would hold its sessions hostage.
// Subagent rollouts are hidden by default (they dominate real trees); pass
// --include-subagents to show them tagged.
async function cmdResumeAll(args, lang) {
  const flags = parseFlags(args);
  const includeSubagents =
    flags['include-subagents'] === true || flags.includeSubagents === true;
  const cwd = process.cwd();
  const sessions = await scanSessions({ cwd, includeSubagents });
  if (sessions.length === 0) {
    process.stdout.write(t(lang, 'resumeNone', { v: cwd }) + '\n');
    return 0;
  }
  process.stdout.write(t(lang, 'resumeHeader', { v: cwd }) + '\n');
  sessions.forEach((s, i) => {
    process.stdout.write(formatSessionLine(s, i + 1) + '\n');
  });
  if (process.stdin.isTTY !== true) {
    process.stdout.write(t(lang, 'resumeListOnly') + '\n');
    return 0;
  }
  const rl = readline.createInterface({ input, output });
  let idx = null;
  try {
    const answer = await rl.question(t(lang, 'resumePrompt', { v: sessions.length }));
    idx = parseSelection(answer, sessions.length);
  } finally {
    rl.close();
  }
  if (idx === null) {
    process.stdout.write(t(lang, 'canceled') + '\n');
    return 0;
  }
  const chosen = sessions[idx];
  const active = await getCurrentProvider();
  if (active && chosen.providerLabel && chosen.providerLabel !== active) {
    process.stdout.write(
      t(lang, 'resumeCrossProvider', { v: chosen.providerLabel, v2: active }) + '\n'
    );
  }
  return await spawnCodex(buildResumeArgs(chosen.id, active));
}

// ----- shared flag parser -----

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          out[a.slice(2)] = true;
        } else {
          out[a.slice(2)] = next;
          i++;
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      out[a.slice(1)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}
