#!/usr/bin/env node
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { runStats } from './stats/command.js';
import { installStatsCommand } from './stats/install-command.js';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

// 输入行队列（用于管道模式）
let inputLines = [];
let inputReady = false;
let inputStarted = false;

// 惰性启动管道输入预加载。必须惰性：若在模块加载时就 attach 'data' 监听，
// stdin 会被 ref 住，event loop 无法退出——`node --test` 的进程隔离模式下
// 子进程 stdin 是 runner 长开的管道，会导致整个测试套件永久挂起。只有真正
// 需要从管道读输入的 ask() 才触发它。
function startPipedInput() {
  if (inputStarted || input.isTTY) return;
  inputStarted = true;
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    inputLines.push(...parts);
  });
  input.on('end', () => {
    if (buffer) inputLines.push(buffer);
    inputReady = true;
  });
}

// 全局 readline 接口（仅用于 TTY 模式）
let globalRl = null;
function getReadline() {
  if (!globalRl && input.isTTY) {
    globalRl = readline.createInterface({ input, output });
  }
  return globalRl;
}

export function closeReadline() {
  if (!globalRl) return;
  globalRl.close();
  globalRl = null;
}

import {
  buildNativeContext,
  buildNativeDoctorLines,
  buildNativeRuntimePrompt,
  buildTaskSignalSummary,
  defaultNativeConfig,
  nativeStateLabel,
  validateNativeProfile
} from './shared/native-context.js';
import {
  buildProviderBehaviorProfile,
  preferredProtocolOrder
} from './shared/provider-profile.js';
import { resolveCommand, resolveClaudeCommand } from './shared/resolve-launcher.js';
import { buildAlignmentPolicy } from './shared/alignment-policy.js';
import { buildProviderTuning } from './shared/provider-tuning.js';
import { classifyPromptSignals } from './shared/prompt-signals.js';
import { buildDynamicRouteGuidance, buildRouteDecision } from './shared/route-guidance.js';
import {
  appendSessionStep,
  buildSessionContext,
  inferStepKind,
  readSessionState,
  writeSessionState
} from './shared/session-guidance.js';
import {
  buildSubagentQualityGate,
  buildSubagentQualityGuidance
} from './shared/subagent-quality.js';
import {
  buildTaskQualityGate,
  buildTaskQualityGuidance
} from './shared/task-quality.js';


const home = os.homedir();
const claudeDir = path.join(home, '.claude');
const globalClaudeSettingsFile = path.join(claudeDir, 'settings.json');
const appDir = path.join(home, '.config', 'claudex-cli');
const backupsDir = path.join(appDir, 'backups');
const currentProviderFile = path.join(appDir, 'current-provider');
const languageFile = path.join(appDir, 'language');
const nativeConfigFile = path.join(appDir, 'native.json');
const sessionStateFile = path.join(appDir, 'native-session.json');
const legacyCurrentProviderFile = path.join(claudeDir, 'current-provider');

const defaultGlobalClaudeSettings = {
  env: {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    ENABLE_TOOL_SEARCH: 'false'
  }
};
class BackSignal extends Error {
  constructor() {
    super('BACK_SIGNAL');
    this.name = 'BackSignal';
  }
}

const BANNER_ART = [
  '  ____ _        _   _   _ ____  _______  __',
  ' / ___| |      / \\ | | | |  _ \\| ____\\ \\/ /',
  '| |   | |     / _ \\| | | | | | |  _|  \\  / ',
  '| |___| |___ / ___ \\ |_| | |_| | |___ /  \\ ',
  ' \\____|_____/_/   \\_\\___/|____/|_____/_/\\_\\'
];

const TXT = {
  zh: {
    menuTitle: 'Claudex 主菜单',
    bannerSub: 'Provider Switching Console',
    bannerBy: 'Powered by github.com/guihai24',
    m1: '1. 开始配置 / 添加服务商',
    m2: '2. 查看当前配置',
    m3: '3. 切换模型服务商',
    m4: '4. 管理模型服务商',
    m5: '5. 查看 Token 消耗情况',
    m6: '6. 诊断 (doctor)',
    m7: '7. 更多',
    m8: '8. 退出',
    choose18: '请选择 (1-8): ',
    invalid18: '输入无效，请输入 1-8。',
    bye: '👋 已退出。',
    currentProvider: '📌 当前服务商: {v}',
    currentSettings: '当前配置文件: {file} {state}',
    currentEndpoint: '接入点: {v}',
    currentModels: '模型: haiku={haiku}, sonnet={sonnet}, opus={opus}',
    providers: '服务商列表: {v}',
    noProviders: '未找到任何服务商配置（~/.claude/settings.<name>.json）',
    noActiveProvider: '⚠️ 当前未设置服务商，请执行: claudex use <name>',
    providersAvailable: '可选服务商:',
    askProvider: '请输入服务商序号或名称: ',
    askSwitchTo: '请输入要切换到的服务商序号或名称: ',
    askEdit: '请输入要编辑的服务商序号或名称: ',
    askDelete: '请输入要删除的服务商序号或名称: ',
    notEnteredProvider: '未输入服务商名称',
    providerIndexOutOfRange: '序号超出范围，请输入有效序号。',
    providerNotFound: '未找到服务商: {v}',
    manageTitle: '管理模型服务商',
    mg1: '1. 列出服务商',
    mg2: '2. 新增服务商',
    mg3: '3. 编辑服务商（逐字段，回车保留原值）',
    mg4: '4. 删除服务商',
    mg5: '5. 返回主菜单',
    choose15: '请选择 (1-5): ',
    invalid15: '输入无效，请输入 1-5。',
    moreTitle: '更多',
    more1: '1. Native 模式',
    more2: '2. 实时显示上下文状态',
    more3: '3. 初始化/修复 shell 快捷函数',
    more4: '4. 显示命令帮助',
    more5: '5. 语言设置（中文 / English）',
    more6: '6. 返回主菜单',
    choose16more: '请选择 (1-6): ',
    invalid16more: '输入无效，请输入 1-6。',
    langTitle: '语言设置',
    lang1: '1. 中文',
    lang2: '2. English',
    lang3: '3. 返回',
    langChoose: '请选择 (1-3): ',
    langInvalid: '输入无效，请输入 1-3。',
    langSaved: '语言已切换为: {v}',
    contextUsageTitle: '实时显示上下文状态',
    contextUsageDesc: '在会话输入框下方显示上下文使用情况（例如：Opus 4.8 (1M context) ████░░░░░░ 36% (359k/1000k)）',
    contextUsageStatus: '当前状态: {status}',
    contextUsageEnabled: '已启用',
    contextUsageDisabled: '已禁用',
    contextUsage1: '1. 启用',
    contextUsage2: '2. 禁用',
    contextUsage3: '3. 返回',
    contextUsageChoose: '请选择 (1-3): ',
    contextUsageInvalid: '输入无效，请输入 1-3。',
    contextUsageSaved: '✅ 已保存: 实时显示上下文状态已{status}',
    opFailed: '❌ 操作失败: {v}',
    execFailed: '❌ 执行失败: {v}',
    saved: '💾 已保存: {v}',
    updated: '✏️ 已更新: {v}',
    deleted: '🗑️ 已删除: {v}',
    cancelled: '已取消',
    editIntro: '正在编辑 {v}（每项回车保留原值，输入新值则替换）:',
    editCurrent: '当前',
    editUnset: '(未设)',
    editNewOrKeep: '新值 (回车保留{hint})',
    editedOk: '✅ 已更新 {v}: {file}',
    testOK: '✅ 测试通过: {name} ({status}) via {protocol}',
    doctorTitle: '🩺 诊断检查:',
    envConflicts: '- 环境变量冲突:',
    envNone: '- 环境变量冲突: 无',
    fixHint: '  修复: unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_BASE_URL',
    doctorNoCurrent: '- 当前服务商: 无',
    providerTestOK: '- 服务商测试: 通过 ({name}, HTTP {status}, {protocol})',
    providerTestFail: '- 服务商测试: 失败 ({name})',
    providerNameQ: '服务商名称（例如 gpt）: ',
    baseUrlQ: '服务地址（例如 https://api.example.com）: ',
    apiKeyQ: 'API Key: ',
    haikuQ: 'Haiku 模型（例如 gpt-5.4-mini）: ',
    sonnetQ: 'Sonnet 模型（例如 gpt-5.4）: ',
    opusQ: 'Opus 模型（例如 gpt-5.4-xhigh）: ',
    requiredErr: 'name/base-url/api-key/haiku-model/sonnet-model/opus-model 为必填项',
    nonInteractiveRequiresYes: '非交互模式删除需要加 --yes。',
    initialized: '初始化完成: {v}',
    shellFile: 'Shell 配置文件: {v}',
    helperAdded: '已写入快捷函数: cdxrun + claude（裸 claude 自动跟随当前服务商）',
    helperUpdated: '已更新快捷函数: cdxrun + claude（裸 claude 自动跟随当前服务商）',
    helperRun: '请执行: source {v}',
    helperExists: '快捷函数已是最新',
    pwshFile: 'PowerShell 配置文件: {v}',
    pwshHelperAdded: '已写入 PowerShell 快捷函数: cdxrun + claude（裸 claude 自动跟随当前服务商）',
    pwshHelperUpdated: '已更新 PowerShell 快捷函数: cdxrun + claude（裸 claude 自动跟随当前服务商）',
    pwshHelperRun: '请执行: . {v}（或新开一个 PowerShell 窗口）',
    pwshHelperExists: 'PowerShell 快捷函数已是最新',
    globalSettingsCreated: '🧩 已创建全局 Claude 配置: {v}',
    globalSettingsExists: 'ℹ️ 已保留现有全局 Claude 配置: {v}',
    wizardSaved: '已保存配置: {v}',
    testNowQ: '是否立即测试连接？(Y/n): ',
    testPass: '连接测试通过: {name} (HTTP {status}, {protocol})',
    claudeNotFound: '⚠️ 未检测到 Claude Code CLI（claude 命令不可用）',
    claudeRequired: 'Claudex 需要 Claude Code 才能正常工作。',
    claudeInstallQ: '是否现在查看官方推荐安装命令？(Y/n): ',
    claudeInstallSkip: '已跳过。请先按官方方式安装 Claude Code，然后重试。',
    claudeInstallManual: '请先执行以下官方推荐安装命令:',
    claudeInstallFallback: '如需备选方式，可使用: {v}',
    claudeInstalled: '- Claude Code: 已安装 ({v})',
    claudeNotInstalled: '- Claude Code: 未安装',
    providerSetupRequired: '⚠️ 还没有可用的服务商配置，先进入引导菜单完成配置。',
    providerSetupMenu: '正在打开 claudex menu ...',
    providerSetupOptional: '如需手动配置，也可以运行: claudex add',
    nativeTitle: 'Native 模式',
    native1: '1. 开启 Native 模式',
    native2: '2. 关闭 Native 模式',
    native3: '3. 查看 Native 状态',
    native4: '4. 选择 Native 配置档',
    native5: '5. Native 检查',
    native6: '6. 返回主菜单',
    nativeChoose: '请选择 (1-6): ',
    nativeInvalid: '输入无效，请输入 1-6。',
    nativeEnabled: '✅ Native 模式已开启',
    nativeDisabled: '⏸️ Native 模式已关闭',
    nativeStatus: 'Native 模式: {state}',
    nativeProfile: 'Native 配置档: {profile}',
    nativeStateOn: '已开启',
    nativeStateOff: '已关闭',
    nativeInherited: 'Native 模式: 已继承 ({profile})',
    nativeProfilePrompt: '请选择配置档 (1-3): ',
    nativeProfileInvalid: '输入无效，请输入 1-3。',
    nativeProfileSet: '✅ Native 配置档已设置为: {profile}',
    nativeProfileHelp: '可选配置档: stable / native / aggressive',
    nativeProfileTitle: '选择 Native 配置档',
    nativeProfile1: '1. stable       （更稳，更保守）',
    nativeProfile2: '2. native       （默认，贴近原生 Claude Code）',
    nativeProfile3: '3. aggressive   （更激进，更偏高峰值原生体验与 workflow reuse）',
    nativeProfile4: '4. 返回',
    nativeDoctorTitle: 'Native 检查:',
    nativeDoctorSummary: '- Native 状态: {state} ({profile})',
    nativeDoctorInject: '- 注入方式: 启动 Claude 时追加结构化 runtime context',
    nativeDoctorPriority: '- 优先级: 若显式传入 --system-prompt/--append-system-prompt，则以显式输入为准',
    nativeUsage: '用法: claudex native <on|off|status|profile|doctor>',
  },
  en: {
    menuTitle: 'Claudex Main Menu',
    bannerSub: 'Provider Switching Console',
    bannerBy: 'Powered by github.com/guihai24',
    m1: '1. Initial setup / add provider',
    m2: '2. View current configuration',
    m3: '3. Switch model provider',
    m4: '4. Manage model providers',
    m5: '5. View token usage',
    m6: '6. Diagnose (doctor)',
    m7: '7. More',
    m8: '8. Exit',
    choose18: 'Choose (1-8): ',
    invalid18: 'Invalid input. Enter 1-8.',
    bye: '👋 Exited.',
    currentProvider: '📌 Current provider: {v}',
    currentSettings: 'Current settings: {file} {state}',
    currentEndpoint: 'Endpoint: {v}',
    currentModels: 'Models: haiku={haiku}, sonnet={sonnet}, opus={opus}',
    providers: 'Providers: {v}',
    noProviders: 'No providers found in ~/.claude/settings.<name>.json',
    noActiveProvider: '⚠️ No active provider. Run: claudex use <name>',
    providersAvailable: 'Available providers:',
    askProvider: 'Enter provider index or name: ',
    askSwitchTo: 'Enter provider index or name to switch to: ',
    askEdit: 'Enter provider index or name to edit: ',
    askDelete: 'Enter provider index or name to delete: ',
    notEnteredProvider: 'No provider name entered',
    providerIndexOutOfRange: 'Index out of range. Enter a valid provider index.',
    providerNotFound: 'Provider not found: {v}',
    manageTitle: 'Manage Model Providers',
    mg1: '1. List providers',
    mg2: '2. Add provider',
    mg3: '3. Edit provider (field-by-field, Enter to keep current)',
    mg4: '4. Delete provider',
    mg5: '5. Back to main menu',
    choose15: 'Choose (1-5): ',
    invalid15: 'Invalid input. Enter 1-5.',
    moreTitle: 'More',
    more1: '1. Native mode',
    more2: '2. Live context usage meter',
    more3: '3. Initialize/repair shell helpers',
    more4: '4. Show command help',
    more5: '5. Language (中文 / English)',
    more6: '6. Back to main menu',
    choose16more: 'Choose (1-6): ',
    invalid16more: 'Invalid input. Enter 1-6.',
    langTitle: 'Language',
    lang1: '1. Chinese',
    lang2: '2. English',
    lang3: '3. Back',
    langChoose: 'Choose (1-3): ',
    langInvalid: 'Invalid input. Enter 1-3.',
    langSaved: 'Language set to: {v}',
    contextUsageTitle: 'Live context usage meter',
    contextUsageDesc: 'Show context usage under the session input (e.g. Opus 4.8 (1M context) ████░░░░░░ 36% (359k/1000k))',
    contextUsageStatus: 'Current status: {status}',
    contextUsageEnabled: 'enabled',
    contextUsageDisabled: 'disabled',
    contextUsage1: '1. Enable',
    contextUsage2: '2. Disable',
    contextUsage3: '3. Back',
    contextUsageChoose: 'Choose (1-3): ',
    contextUsageInvalid: 'Invalid input. Enter 1-3.',
    contextUsageSaved: '✅ Saved: live context usage meter {status}',
    opFailed: '❌ Operation failed: {v}',
    execFailed: '❌ Execution failed: {v}',
    saved: '💾 Saved: {v}',
    updated: '✏️ Updated: {v}',
    deleted: '🗑️ Deleted: {v}',
    cancelled: 'Cancelled',
    editIntro: 'Editing {v} (press Enter to keep current value, type new value to replace):',
    editCurrent: 'current',
    editUnset: '(unset)',
    editNewOrKeep: 'new value (Enter to keep{hint})',
    editedOk: '✅ Updated {v}: {file}',
    testOK: '✅ Test OK: {name} ({status}) via {protocol}',
    doctorTitle: '🩺 Doctor checks:',
    envConflicts: '- Env conflicts:',
    envNone: '- Env conflicts: none',
    fixHint: '  Fix: unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_BASE_URL',
    doctorNoCurrent: '- Current provider: none',
    providerTestOK: '- Provider test: OK ({name}, HTTP {status}, {protocol})',
    providerTestFail: '- Provider test: FAIL ({name})',
    providerNameQ: 'Provider name (e.g. gpt): ',
    baseUrlQ: 'Base URL (e.g. https://api.example.com): ',
    apiKeyQ: 'API Key: ',
    haikuQ: 'Haiku model (e.g. gpt-5.4-mini): ',
    sonnetQ: 'Sonnet model (e.g. gpt-5.4): ',
    opusQ: 'Opus model (e.g. gpt-5.4-xhigh): ',
    requiredErr: 'name/base-url/api-key/haiku-model/sonnet-model/opus-model are required.',
    nonInteractiveRequiresYes: 'Non-interactive removal requires --yes.',
    initialized: 'Initialized: {v}',
    shellFile: 'Shell file: {v}',
    helperAdded: 'Injected shell helpers: cdxrun + claude (bare claude follows the current provider)',
    helperUpdated: 'Updated shell helpers: cdxrun + claude (bare claude follows the current provider)',
    helperRun: 'Run: source {v}',
    helperExists: 'Shell helpers already up to date',
    pwshFile: 'PowerShell profile: {v}',
    pwshHelperAdded: 'Injected PowerShell helpers: cdxrun + claude (bare claude follows the current provider)',
    pwshHelperUpdated: 'Updated PowerShell helpers: cdxrun + claude (bare claude follows the current provider)',
    pwshHelperRun: 'Run: . {v} (or open a new PowerShell window)',
    pwshHelperExists: 'PowerShell helpers already up to date',
    globalSettingsCreated: '🧩 Created global Claude settings: {v}',
    globalSettingsExists: 'ℹ️ Kept existing global Claude settings: {v}',
    wizardSaved: 'Saved config: {v}',
    testNowQ: 'Test connection now? (Y/n): ',
    testPass: 'Connection test passed: {name} (HTTP {status}, {protocol})',
    claudeNotFound: '⚠️ Claude Code CLI not found (claude command unavailable)',
    claudeRequired: 'Claudex requires Claude Code to work properly.',
    claudeInstallQ: 'Show the official recommended Claude Code install command now? (Y/n): ',
    claudeInstallSkip: 'Skipped. Install Claude Code with an official method, then retry.',
    claudeInstallManual: 'Run this official recommended install command first:',
    claudeInstallFallback: 'Optional fallback: {v}',
    claudeInstalled: '- Claude Code: installed ({v})',
    claudeNotInstalled: '- Claude Code: not installed',
    providerSetupRequired: '⚠️ No provider configuration is available yet. Opening guided setup first.',
    providerSetupMenu: 'Opening claudex menu ...',
    providerSetupOptional: 'If you prefer manual setup, you can also run: claudex add',
    nativeTitle: 'Native Mode',
    native1: '1. Turn Native mode on',
    native2: '2. Turn Native mode off',
    native3: '3. View Native status',
    native4: '4. Choose Native profile',
    native5: '5. Run Native checks',
    native6: '6. Back to main menu',
    nativeChoose: 'Choose (1-6): ',
    nativeInvalid: 'Invalid input. Enter 1-6.',
    nativeEnabled: '✅ Native mode enabled',
    nativeDisabled: '⏸️ Native mode disabled',
    nativeStatus: 'Native mode: {state}',
    nativeProfile: 'Native profile: {profile}',
    nativeStateOn: 'on',
    nativeStateOff: 'off',
    nativeInherited: 'Native mode: inherited ({profile})',
    nativeProfilePrompt: 'Choose profile (1-3): ',
    nativeProfileInvalid: 'Invalid input. Enter 1-3.',
    nativeProfileSet: '✅ Native profile set to: {profile}',
    nativeProfileHelp: 'Available profiles: stable / native / aggressive',
    nativeProfileTitle: 'Choose Native profile',
    nativeProfile1: '1. stable       (prioritize reliability and guardrails)',
    nativeProfile2: '2. native       (default; prioritize native Claude Code feel)',
    nativeProfile3: '3. aggressive   (prioritize peak native-like experience)',
    nativeDoctorTitle: 'Native checks:',
    nativeDoctorSummary: '- Native status: {state} ({profile})',
    nativeDoctorInject: '- Injection: append structured runtime context when launching Claude',
    nativeDoctorPriority: '- Priority: explicit --system-prompt/--append-system-prompt always wins',
    nativeUsage: 'usage: claudex native <on|off|status|profile|doctor>',
  }
};

function t(lang, key, vars = {}) {
  const table = TXT[lang] || TXT.zh;
  const base = table[key] || TXT.zh[key] || key;
  return base.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

function isBackInput(v) {
  const s = (v || '').trim().toLowerCase();
  return s === 'b' || s === 'back';
}

function renderBanner(lang) {
  const width = BANNER_ART.reduce((m, line) => Math.max(m, line.length), 0);
  const center = (text) => {
    const s = String(text ?? '');
    const left = Math.max(0, Math.floor((width - s.length) / 2));
    return `${' '.repeat(left)}${s}`;
  };

  console.log('');
  for (const line of BANNER_ART) {
    console.log(line);
  }
  console.log(center(t(lang, 'bannerSub')));
  console.log(center(t(lang, 'bannerBy')));
  console.log('');
}

function usage() {
  console.log(`claudex v0.1.0

Usage:
  claudex                     # 直接启动 Claude（使用当前配置）
  claudex --continue          # 继续最近一次会话
  claudex menu                # 进入交互菜单
  claudex init
  claudex add [--current] [--no-input]
  claudex edit <name|index> [--base-url U --api-key K --haiku-model H --sonnet-model S --opus-model O]
  claudex list
  claudex use <name|index>
  claudex remove <name|index> [--yes]
  claudex test [name|index]
  claudex lang <zh|en|中文|英文>
  claudex status
  claudex native <on|off|status|profile|doctor>
  claudex update [--from-local <path>]
  claudex run [claude args...]
  claudex stats [--week|--month|--year|--since DATE] [--json]
  claudex provider add [--name N --base-url URL --api-key KEY --haiku-model H --sonnet-model S --opus-model O]
  claudex provider list
  claudex provider use <name>
  claudex provider remove <name> [--yes]
  claudex provider test <name>
  claudex doctor [--provider <name>]

Examples:
  claudex
  claudex --continue
  claudex menu
  claudex use gpt
  claudex native on
  claudex native profile native
  claudex test
  claudex update
  claudex run --continue

Credentials:
  CLAUDEX_API_KEY=... claudex add ...   # avoid putting the key in shell history
`);
}

function statsUsage() {
  console.log(`Usage: claudex stats [options]

Options:
  --week                 最近 7 天（默认）
  --month                最近 30 天
  --year                 最近 365 天
  --since YYYY-MM-DD     从指定日期开始
  --idle-gap 5m|2h       活跃时长的空闲阈值
  --json                 输出 JSON
`);
}

const CLAUDE_PROVIDER_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function isValidClaudeProviderName(name) {
  return typeof name === 'string' && CLAUDE_PROVIDER_NAME_RE.test(name);
}

function providerSettingsPath(name) {
  if (!isValidClaudeProviderName(name)) {
    throw new Error('invalid provider name: use letters, numbers, _ or -');
  }
  return path.join(claudeDir, `settings.${name}.json`);
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function backupFile(file) {
  if (!(await exists(file))) return null;
  await ensureDir(backupsDir);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const dst = path.join(backupsDir, `${path.basename(file)}.${stamp}.bak`);
  await fsp.copyFile(file, dst);
  return dst;
}

async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(file, obj) {
  const txt = JSON.stringify(obj, null, 2) + '\n';
  await fsp.writeFile(file, txt, { mode: 0o600 });
}

async function ensureGlobalClaudeSettings(lang, { quiet = false } = {}) {
  await ensureDir(claudeDir);

  if (await exists(globalClaudeSettingsFile)) {
    if (!quiet) console.log(t(lang, 'globalSettingsExists', { v: globalClaudeSettingsFile }));
    return { created: false, file: globalClaudeSettingsFile };
  }

  await writeJson(globalClaudeSettingsFile, defaultGlobalClaudeSettings);
  if (!quiet) console.log(t(lang, 'globalSettingsCreated', { v: globalClaudeSettingsFile }));
  return { created: true, file: globalClaudeSettingsFile };
}

async function readSessionStateFile() {
  return readSessionState(sessionStateFile, async (file) => await fsp.readFile(file, 'utf8'));
}

async function writeSessionStateFile(state) {
  await writeSessionState(sessionStateFile, state, async (file, content) => {
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, content + '\n', { mode: 0o600 });
  });
}

async function listProviders() {
  if (!(await exists(claudeDir))) return [];
  const entries = await fsp.readdir(claudeDir);
  const out = [];
  for (const item of entries) {
    const m = item.match(/^settings\.(.+)\.json$/);
    if (m && isValidClaudeProviderName(m[1])) out.push(m[1]);
  }
  out.sort();
  return out;
}

async function getCurrentProvider() {
  if (await exists(currentProviderFile)) {
    const p = (await fsp.readFile(currentProviderFile, 'utf8')).trim();
    if (p) return p;
  }

  // Compatibility: migrate legacy state from ~/.claude/current-provider.
  if (await exists(legacyCurrentProviderFile)) {
    const legacy = (await fsp.readFile(legacyCurrentProviderFile, 'utf8')).trim();
    if (legacy && (await exists(providerSettingsPath(legacy)))) {
      await setCurrentProvider(legacy);
      return legacy;
    }
  }

  // Compatibility: infer from CLAUDE_SETTINGS_FILE if present.
  const settingsFile = process.env.CLAUDE_SETTINGS_FILE || '';
  const m = settingsFile.match(/settings\.([a-zA-Z0-9_-]+)\.json$/);
  if (m && m[1] && (await exists(providerSettingsPath(m[1])))) {
    await setCurrentProvider(m[1]);
    return m[1];
  }

  return null;
}

async function setCurrentProvider(name) {
  await ensureDir(appDir);
  await fsp.writeFile(currentProviderFile, `${name}\n`, 'utf8');
}


async function getNativeConfig() {
  if (!(await exists(nativeConfigFile))) return defaultNativeConfig();
  try {
    const data = await readJson(nativeConfigFile);
    return {
      enabled: Boolean(data?.enabled),
      profile: validateNativeProfile(data?.profile) || 'native'
    };
  } catch {
    return defaultNativeConfig();
  }
}

async function writeNativeConfig(config) {
  await ensureDir(appDir);
  const next = {
    enabled: Boolean(config?.enabled),
    profile: validateNativeProfile(config?.profile) || 'native'
  };
  await writeJson(nativeConfigFile, next);
  return next;
}

async function setNativeConfig(patch) {
  const current = await getNativeConfig();
  return writeNativeConfig({ ...current, ...patch });
}

async function cmdNativeStatus(lang) {
  const config = await getNativeConfig();
  console.log(t(lang, 'nativeStatus', { state: nativeStateLabel(lang, config.enabled) }));
  console.log(t(lang, 'nativeProfile', { profile: config.profile }));
}

async function cmdNativeDoctor(lang) {
  const current = await getCurrentProvider();
  const config = await getNativeConfig();
  const settingsFile = current ? providerSettingsPath(current) : '';
  let context = buildNativeContext(config, {
    providerName: current || 'unknown',
    settingsFile: settingsFile || 'unknown',
    protocolMode: 'unknown',
    slotMapping: {},
    compatibilityHints: []
  });

  if (current && (await exists(settingsFile))) {
    const settings = await readJson(settingsFile);
    const auth = readProviderAuth(settings);
    context = await buildRuntimeNativeContext(current, settingsFile, config, auth, '');
  }

  for (const line of buildNativeDoctorLines(context, lang)) {
    console.log(line);
  }
  const profile = context.provider_profile;
  if (profile) {
    if (lang === 'zh') {
      console.log(`- Provider 画像: family=${profile.provider_family}, surface=${profile.api_surface}, native_reliability=${profile.native_reliability}, agent_routing=${profile.agent_routing_stability}, tool_use=${profile.tool_use_stability}`);
    } else {
      console.log(`- Provider profile: family=${profile.provider_family}, surface=${profile.api_surface}, native_reliability=${profile.native_reliability}, agent_routing=${profile.agent_routing_stability}, tool_use=${profile.tool_use_stability}`);
    }
  }
  const tuning = context.provider_tuning;
  if (tuning) {
    const currentProfile = context.native_profile || 'native';
    const matchesRecommendation = currentProfile === tuning.recommended_profile;
    if (lang === 'zh') {
      console.log(`- 推荐 profile: ${tuning.recommended_profile} (${tuning.tuned_policy_pack})`);
      console.log(`- 推荐来源: ${tuning.recommendation_source || 'unknown'} | 置信度: ${tuning.confidence || 'unknown'}`);
      console.log(`- 当前采用: ${currentProfile}${matchesRecommendation ? '（与推荐一致）' : '（与推荐不一致）'}`);
      console.log(`- 推荐理由: ${tuning.rationale.join('；')}`);
      const taskSignals = buildTaskSignalSummary(context.task_signals);
      if (taskSignals) {
        console.log(`- 动态任务信号: ${taskSignals}`);
      }
    } else {
      console.log(`- Recommended profile: ${tuning.recommended_profile} (${tuning.tuned_policy_pack})`);
      console.log(`- Recommendation source: ${tuning.recommendation_source || 'unknown'} | confidence: ${tuning.confidence || 'unknown'}`);
      console.log(`- Current profile: ${currentProfile}${matchesRecommendation ? ' (matches recommendation)' : ' (differs from recommendation)'}`);
      console.log(`- Rationale: ${tuning.rationale.join('; ')}`);
    }
  }
  const policy = context.alignment_policy;
  if (policy) {
    if (lang === 'zh') {
      console.log(`- 对齐策略: routing=${policy.routing_hints.join(', ') || 'none'} | response=${policy.response_style_hints.join(', ') || 'none'} | delegation=${policy.delegation_hints.join(', ') || 'none'}`);
    } else {
      console.log(`- Alignment policy: routing=${policy.routing_hints.join(', ') || 'none'} | response=${policy.response_style_hints.join(', ') || 'none'} | delegation=${policy.delegation_hints.join(', ') || 'none'}`);
    }
  }
}

async function pickNativeProfile(lang) {
  while (true) {
    console.log(`\n${t(lang, 'nativeProfileTitle')}`);
    console.log(t(lang, 'nativeProfile1'));
    console.log(t(lang, 'nativeProfile2'));
    console.log(t(lang, 'nativeProfile3'));
    console.log(t(lang, 'nativeProfile4'));
    const choice = await ask(t(lang, 'nativeProfilePrompt'));
    if (choice === '1') return 'stable';
    if (choice === '2') return 'native';
    if (choice === '3') return 'aggressive';
    if (choice === '4' || isBackInput(choice)) throw new BackSignal();
    console.log(t(lang, 'nativeProfileInvalid'));
  }
}


async function cmdNative(subArgs, lang) {
  const [action, ...rest] = subArgs;

  if (!action) {
    await cmdNativeStatus(lang);
    return;
  }

  if (action === 'on') {
    const config = await setNativeConfig({ enabled: true });
    console.log(t(lang, 'nativeEnabled'));
    console.log(t(lang, 'nativeProfile', { profile: config.profile }));
    return;
  }

  if (action === 'off') {
    const config = await setNativeConfig({ enabled: false });
    console.log(t(lang, 'nativeDisabled'));
    console.log(t(lang, 'nativeProfile', { profile: config.profile }));
    return;
  }

  if (action === 'status') {
    await cmdNativeStatus(lang);
    return;
  }

  if (action === 'doctor') {
    await cmdNativeDoctor(lang);
    return;
  }

  if (action === 'profile') {
    const candidate = validateNativeProfile(rest[0]);
    if (candidate) {
      await setNativeConfig({ profile: candidate });
      console.log(t(lang, 'nativeProfileSet', { profile: candidate }));
      return;
    }
    if (rest[0]) throw new Error(t(lang, 'nativeProfileHelp'));
    const profile = await pickNativeProfile(lang);
    await setNativeConfig({ profile });
    console.log(t(lang, 'nativeProfileSet', { profile }));
    return;
  }

  throw new Error(t(lang, 'nativeUsage'));
}

async function getLanguage() {
  if (await exists(languageFile)) {
    const v = (await fsp.readFile(languageFile, 'utf8')).trim().toLowerCase();
    if (v === 'zh' || v === 'en') return v;
  }
  return 'zh';
}

function normalizeLanguage(inputLang) {
  const v = (inputLang || '').trim().toLowerCase();
  if (v === 'zh' || v === 'cn' || v === 'zh-cn' || v === 'chinese' || v === '中文') return 'zh';
  if (v === 'en' || v === 'en-us' || v === 'english' || v === '英文') return 'en';
  return '';
}

async function setLanguage(lang) {
  const v = normalizeLanguage(lang);
  if (!v) throw new Error('language must be zh/en or 中文/英文');
  await ensureDir(appDir);
  await fsp.writeFile(languageFile, `${v}\n`, 'utf8');
  return v;
}

// Launcher resolution lives in ./shared/resolve-launcher.js (shared with the
// codex CLI). Re-export so existing imports of these keep resolving via cli.js.
export { resolveCommand, resolveClaudeCommand };

// Spawn the resolved claude, threading the caller's options through untouched.
function spawnClaude(args, options = {}) {
  const { file, prefixArgs, shell } = resolveClaudeCommand();
  return spawn(file, [...prefixArgs, ...args], shell ? { ...options, shell: true } : options);
}

function execClaudeSync(args, options = {}) {
  const { file, prefixArgs, shell } = resolveClaudeCommand();
  return execFileSync(file, [...prefixArgs, ...args], shell ? { ...options, shell: true } : options);
}

function getClaudeVersion() {
  try {
    return execClaudeSync(['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function shellRcFile() {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return path.join(home, '.zshrc');
  if (shell.includes('bash')) return path.join(home, '.bashrc');
  return path.join(home, '.zshrc');
}

const SHELL_BLOCK_BEGIN = '# BEGIN CLAUDEX-SWITCHER';
const SHELL_BLOCK_END = '# END CLAUDEX-SWITCHER';

// Build the managed shell block (no trailing newline). Defines `cdxrun` plus a
// bare `claude` wrapper so that running `claude` directly auto-uses the current
// provider's settings file — while staying out of the way when the user already
// has their own auth.
export function buildShellBlock() {
  return [
    SHELL_BLOCK_BEGIN,
    '# Run Claude with the current provider.',
    'cdxrun() { claudex run "$@"; }',
    '',
    '# Bare `claude` uses the current provider; yields to an explicit --settings,',
    '# pre-set ANTHROPIC_* creds, or a missing/unconfigured provider.',
    'claude() {',
    '  case "$*" in *--settings*) command claude "$@"; return;; esac',
    '  if [ -n "$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" ]; then command claude "$@"; return; fi',
    '  local __cdx_provider __cdx_settings',
    '  __cdx_provider=$(cat "$HOME/.config/claudex-cli/current-provider" 2>/dev/null)',
    '  __cdx_settings="$HOME/.claude/settings.$__cdx_provider.json"',
    '  if [ -n "$__cdx_provider" ] && [ -f "$__cdx_settings" ]; then',
    '    command claude --settings "$__cdx_settings" "$@"',
    '  else',
    '    command claude "$@"',
    '  fi',
    '}',
    SHELL_BLOCK_END
  ].join('\n');
}

// Insert or replace the managed block in `content`. Pure helper: returns the new
// file content plus whether the block was created / updated / left unchanged.
// Anything outside the markers is preserved untouched.
export function upsertShellBlock(content, block) {
  const existing = content || '';
  const beginIdx = existing.indexOf(SHELL_BLOCK_BEGIN);
  const endIdx = existing.indexOf(SHELL_BLOCK_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx >= beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + SHELL_BLOCK_END.length);
    const next = `${before}${block}${after}`;
    return { next, action: next === existing ? 'unchanged' : 'updated' };
  }
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  return { next: `${existing}${sep}${block}\n`, action: 'created' };
}

async function injectShellBlock() {
  const rc = shellRcFile();
  let content = '';
  if (await exists(rc)) content = await fsp.readFile(rc, 'utf8');
  const { next, action } = upsertShellBlock(content, buildShellBlock());
  if (action === 'unchanged') return { rc, action };
  await backupFile(rc);
  await fsp.writeFile(rc, next, 'utf8');
  return { rc, action };
}

// Build the managed PowerShell block (no trailing newline). buildShellBlock()'s
// wrapper only works in bash/zsh; this is the PowerShell 7 analog so a bare
// `claude` in pwsh also follows the current provider. Reuses the same BEGIN/END
// markers (`#` is a comment in PowerShell too), so upsertShellBlock applies.
export function buildPowerShellBlock() {
  return [
    SHELL_BLOCK_BEGIN,
    '# Run Claude with the current provider.',
    'function cdxrun { claudex run @args }',
    '',
    '# Bare `claude` uses the current provider; yields to an explicit --settings,',
    '# pre-set ANTHROPIC_* creds, or a missing/unconfigured provider.',
    'function claude {',
    '  $real = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source',
    "  if (-not $real) { Write-Error 'claude not found on PATH'; return }",
    '  if (("$args" -like \'*--settings*\') -or $env:ANTHROPIC_API_KEY -or $env:ANTHROPIC_AUTH_TOKEN) { & $real @args; return }',
    '  $provider = (Get-Content "$HOME\\.config\\claudex-cli\\current-provider" -ErrorAction SilentlyContinue | Select-Object -First 1)',
    '  $settings = "$HOME\\.claude\\settings.$provider.json"',
    '  if ($provider -and (Test-Path $settings)) { & $real --settings $settings @args } else { & $real @args }',
    '}',
    SHELL_BLOCK_END
  ].join('\n');
}

function defaultPowerShellProfilePath() {
  return path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
}

// Ask pwsh for the real $PROFILE path (handles OneDrive Documents redirection);
// fall back to the conventional location if pwsh cannot be queried. Injectable
// for tests via opts.queryProfile / opts.fallback.
export function powerShellProfilePath(opts = {}) {
  const query = opts.queryProfile
    || (() => execFileSync('pwsh', ['-NoProfile', '-NoLogo', '-Command', '$PROFILE'], { encoding: 'utf8' }));
  try {
    const out = String(query() || '').trim();
    if (out) return out;
  } catch {
    // pwsh not found / not runnable — fall through to the conventional path.
  }
  return opts.fallback || defaultPowerShellProfilePath();
}

async function injectPowerShellProfile() {
  const profile = powerShellProfilePath();
  await ensureDir(path.dirname(profile));
  let content = '';
  if (await exists(profile)) content = await fsp.readFile(profile, 'utf8');
  const { next, action } = upsertShellBlock(content, buildPowerShellBlock());
  if (action === 'unchanged') return { profile, action };
  await backupFile(profile);
  await fsp.writeFile(profile, next, 'utf8');
  return { profile, action };
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt && !nxt.startsWith('-')) {
        flags[key] = nxt;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

async function ask(question) {
  // 管道模式：从预加载的行队列中读取
  if (!input.isTTY) {
    startPipedInput();
    // 等待输入就绪
    while (!inputReady && inputLines.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    output.write(question);
    const answer = inputLines.shift() || '';
    return answer.trim();
  }

  // TTY 模式：使用 readline
  const rl = getReadline();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function promptProviderAdd(flags, lang) {
  const apiKey = flags['api-key'] || process.env.CLAUDEX_API_KEY;
  const interactive = input.isTTY === true && flags['no-input'] !== true;
  const required = [
    flags.name,
    flags['base-url'],
    apiKey,
    flags['haiku-model'],
    flags['sonnet-model'],
    flags['opus-model']
  ];
  if (!interactive && required.some((value) => !value)) {
    throw new Error(t(lang, 'requiredErr'));
  }

  console.log(t(lang, 'backGuide'));
  const askOrFlag = async (flagValue, key) => {
    if (flagValue) return flagValue;
    const value = await ask(t(lang, key));
    if (isBackInput(value)) throw new BackSignal();
    return value;
  };

  const name = await askOrFlag(flags.name, 'providerNameQ');
  const baseUrl = await askOrFlag(flags['base-url'], 'baseUrlQ');
  const resolvedApiKey = await askOrFlag(apiKey, 'apiKeyQ');
  const haikuModel = await askOrFlag(flags['haiku-model'], 'haikuQ');
  const sonnetModel = await askOrFlag(flags['sonnet-model'], 'sonnetQ');
  const opusModel = await askOrFlag(flags['opus-model'], 'opusQ');

  if (!name || !baseUrl || !resolvedApiKey || !haikuModel || !sonnetModel || !opusModel) {
    throw new Error(t(lang, 'requiredErr'));
  }

  return { name, baseUrl, apiKey: resolvedApiKey, haikuModel, sonnetModel, opusModel };
}

async function writeProviderSettings({ name, baseUrl, apiKey, haikuModel, sonnetModel, opusModel }) {
  await ensureDir(claudeDir);
  const file = providerSettingsPath(name);
  await backupFile(file);
  const data = {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel
    }
  };
  await writeJson(file, data);
  return file;
}

function maskApiKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '(not set)';
  if (key.length <= 10) return key.slice(0, 3) + '***';
  return key.slice(0, 7) + '...' + key.slice(-4);
}

async function readProviderSettings(name) {
  const file = providerSettingsPath(name);
  if (!(await exists(file))) throw new Error(`provider settings not found: ${file}`);
  const data = await readJson(file);
  const env = (data && data.env) || {};
  return {
    name,
    baseUrl: env.ANTHROPIC_BASE_URL || '',
    apiKey: env.ANTHROPIC_API_KEY || '',
    haikuModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
    sonnetModel: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
    opusModel: env.ANTHROPIC_DEFAULT_OPUS_MODEL || ''
  };
}

/**
 * Wizard that lets the user EDIT a provider by walking through every
 * field with the current value displayed, accepting Enter to keep or a
 * new value to replace. CLI flags pre-populate (and bypass prompting
 * for that field). Returns the merged provider info ready for write.
 *
 * In non-interactive mode (stdin is not a TTY): only apply field
 * updates from flags; leave every unflagged field at its current value.
 * Does not block on prompts. This is the codexx-style behaviour and
 * makes `claudex edit X --haiku-model Y` work in shell scripts.
 */
async function promptProviderEdit(name, flags, lang) {
  const current = await readProviderSettings(name);
  const interactive = process.stdin.isTTY === true && flags['no-input'] !== true;

  if (!interactive) {
    return {
      name,
      baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : current.baseUrl,
      apiKey: typeof flags['api-key'] === 'string' ? flags['api-key'] : current.apiKey,
      haikuModel: typeof flags['haiku-model'] === 'string' ? flags['haiku-model'] : current.haikuModel,
      sonnetModel: typeof flags['sonnet-model'] === 'string' ? flags['sonnet-model'] : current.sonnetModel,
      opusModel: typeof flags['opus-model'] === 'string' ? flags['opus-model'] : current.opusModel
    };
  }

  console.log(t(lang, 'editIntro', { v: name }));
  const askField = async (flagValue, currentValue, label, hint = '') => {
    if (typeof flagValue === 'string') return flagValue;
    const shown = label === 'api_key' ? maskApiKey(currentValue) : (currentValue || t(lang, 'editUnset'));
    console.log(`  ${label} ${t(lang, 'editCurrent')}: ${shown}`);
    const next = await ask(`  ${t(lang, 'editNewOrKeep', { hint: hint ? ', ' + hint : '' })}: `);
    if (isBackInput(next)) throw new BackSignal();
    return next.length > 0 ? next : currentValue;
  };

  const baseUrl = await askField(flags['base-url'], current.baseUrl, 'base_url');
  const apiKey = await askField(flags['api-key'], current.apiKey, 'api_key');
  const haikuModel = await askField(flags['haiku-model'], current.haikuModel, 'haiku_model');
  const sonnetModel = await askField(flags['sonnet-model'], current.sonnetModel, 'sonnet_model');
  const opusModel = await askField(flags['opus-model'], current.opusModel, 'opus_model');

  return { name, baseUrl, apiKey, haikuModel, sonnetModel, opusModel };
}

function readProviderAuth(settings) {
  const env = settings?.env || {};
  return {
    baseUrl: env.ANTHROPIC_BASE_URL,
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    slotMapping: {
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || ''
    }
  };
}

async function buildRuntimeNativeContext(providerName, settingsFile, config, auth, promptText = '') {
  const protocolMode = preferredProtocolOrder(auth.baseUrl || '')[0] || 'unknown';
  const profile = buildProviderBehaviorProfile({
    providerName,
    baseUrl: auth.baseUrl || '',
    slotMapping: auth.slotMapping || {},
    protocolMode
  });
  const providerTuning = buildProviderTuning({ providerProfile: profile });
  const taskSignals = classifyPromptSignals(promptText);
  const previousSessionState = await readSessionStateFile();
  const resolvedProfile = config?.profile || providerTuning.recommended_profile || 'native';
  const preliminaryRouteDecision = buildRouteDecision({
    taskSignals,
    providerProfile: profile,
    nativeProfile: resolvedProfile
  });
  const sessionContext = buildSessionContext({
    taskSignals,
    routeDecision: preliminaryRouteDecision,
    previousState: previousSessionState
  });
  const routeDecision = buildRouteDecision({
    taskSignals,
    providerProfile: profile,
    nativeProfile: resolvedProfile,
    sessionContext
  });
  const routeGuidance = buildDynamicRouteGuidance({
    taskSignals,
    providerProfile: profile,
    nativeProfile: resolvedProfile,
    sessionContext
  });
  const subagentQualityGate = buildSubagentQualityGate({
    taskSignals,
    routeDecision,
    nativeProfile: resolvedProfile
  });
  const subagentQualityGuidance = buildSubagentQualityGuidance(subagentQualityGate);
  const taskQualityGate = buildTaskQualityGate({
    taskSignals,
    routeDecision,
    nativeProfile: resolvedProfile
  });
  const taskQualityGuidance = buildTaskQualityGuidance(taskQualityGate);
  const alignmentPolicy = buildAlignmentPolicy({
    nativeProfile: resolvedProfile,
    providerProfile: profile,
    policyPack: providerTuning.policy_pack || null,
    taskSignals,
    sessionContext,
    subagentQualityGate,
    taskQualityGate,
    routeDecision
  });

  return buildNativeContext(config, {
    providerName: providerName || 'unknown',
    settingsFile: settingsFile || 'unknown',
    protocolMode,
    slotMapping: auth.slotMapping || {},
    compatibilityHints: profile.compatibility_hints || [],
    taskSignals,
    routeDecision,
    routeGuidance,
    recentStepKind: sessionContext.recentStepKind,
    sessionState: previousSessionState,
    sessionGuidance: sessionContext.sessionGuidance,
    sessionTrajectory: sessionContext.sessionTrajectory,
    longHorizonSession: sessionContext.longHorizonSession,
    longHorizonGuidance: sessionContext.longHorizonGuidance,
    subagentQualityGate,
    subagentQualityGuidance,
    taskQualityGate,
    taskQualityGuidance,
    providerProfile: profile,
    alignmentPolicy,
    providerTuning
  });
}

async function testAnthropicMessages(baseUrl, apiKey, model) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }]
    })
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    return { ok: true, status: res.status, id: data.id || null, protocol: 'anthropic-messages' };
  }

  const text = (await res.text()).slice(0, 500);
  return { ok: true, status: res.status, preview: text, protocol: 'anthropic-messages' };
}

async function testOpenAiCompletions(baseUrl, apiKey, model) {
  const root = baseUrl.replace(/\/$/, '');
  const url = root.endsWith('/chat/completions') ? root : `${root}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }]
    })
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    return { ok: true, status: res.status, id: data.id || null, protocol: 'openai-chat-completions' };
  }

  const text = (await res.text()).slice(0, 500);
  return { ok: true, status: res.status, preview: text, protocol: 'openai-chat-completions' };
}

async function testProviderViaClaude(settingsFile) {
  return await new Promise((resolve, reject) => {
    const child = spawnClaude([
      '--settings', settingsFile,
      '-p', 'Reply with OK only.',
      '--output-format', 'text'
    ], {
      env: sanitizedEnv(defaultNativeConfig())
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, 30000);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, status: 'OK', preview: stdout.trim().slice(0, 120), protocol: 'claude-cli-smoke' });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `claude exited with code ${code}`));
    });
  });
}

function preferredTestProtocols(baseUrl) {
  const root = String(baseUrl || '').trim().toLowerCase();
  if (!root) return ['anthropic', 'openai'];

  const openAiHints = [
    '/v1/chat/completions',
    '/chat/completions',
    'openai',
    'compatible',
    'dashscope',
    'localhost:3003',
    'ice.v.ua'
  ];

  if (openAiHints.some((hint) => root.includes(hint))) {
    return ['openai', 'anthropic'];
  }

  return ['anthropic', 'openai'];
}

async function testProvider(name) {
  const file = providerSettingsPath(name);
  if (!(await exists(file))) throw new Error(`provider not found: ${name}`);

  const settings = await readJson(file);
  const { baseUrl, apiKey, model } = readProviderAuth(settings);
  if (!baseUrl || !apiKey || !model) {
    throw new Error(`invalid settings in ${file}`);
  }

  const protocols = preferredTestProtocols(baseUrl);
  const errors = [];

  for (const protocol of protocols) {
    try {
      if (protocol === 'openai') {
        return await testOpenAiCompletions(baseUrl, apiKey, model);
      }
      return await testAnthropicMessages(baseUrl, apiKey, model);
    } catch (error) {
      errors.push(`${protocol} failed: ${String(error.message || error)}`);
    }
  }

  try {
    return await testProviderViaClaude(file);
  } catch (error) {
    errors.push(`claude-cli-smoke failed: ${String(error.message || error)}`);
  }

  throw new Error(errors.join(' | '));
}

function shouldInjectNativePrompt(extraArgs = []) {
  const args = Array.isArray(extraArgs) ? extraArgs : [];
  return !args.includes('--system-prompt') && !args.includes('--append-system-prompt');
}

function sanitizedEnv(nativeConfig = defaultNativeConfig()) {
  const next = { ...process.env };
  delete next.ANTHROPIC_AUTH_TOKEN;
  delete next.ANTHROPIC_API_KEY;
  delete next.ANTHROPIC_BASE_URL;
  next.CLAUDEX_NATIVE_ENABLED = nativeConfig.enabled ? '1' : '0';
  next.CLAUDEX_NATIVE_PROFILE = nativeConfig.profile || 'native';
  return next;
}

async function runProcess(command, args, env = process.env) {
  const { file, prefixArgs, shell } = resolveCommand(command);
  await new Promise((resolve, reject) => {
    const options = shell ? { stdio: 'inherit', env, shell: true } : { stdio: 'inherit', env };
    const child = spawn(file, [...prefixArgs, ...args], options);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function isClaudeInstalled() {
  try {
    execClaudeSync(['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function recommendedClaudeInstallCommand() {
  if (process.platform === 'darwin') {
    return {
      command: 'curl -fsSL https://claude.ai/install.sh | bash',
      fallback: 'brew install --cask claude-code'
    };
  }

  if (process.platform === 'win32') {
    return {
      command: 'irm https://claude.ai/install.ps1 | iex',
      fallback: 'winget install Anthropic.ClaudeCode'
    };
  }

  return {
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    fallback: ''
  };
}

async function ensureClaudeInstalled(lang) {
  if (isClaudeInstalled()) return true;

  console.log(`\n${t(lang, 'claudeNotFound')}`);
  console.log(t(lang, 'claudeRequired'));
  console.log('');

  const ans = await ask(t(lang, 'claudeInstallQ'));
  if (!shouldRunTestInput(ans)) {
    console.log(t(lang, 'claudeInstallSkip'));
    return false;
  }

  const install = recommendedClaudeInstallCommand();
  console.log(t(lang, 'claudeInstallManual'));
  console.log(`> ${install.command}`);
  if (install.fallback) {
    console.log(t(lang, 'claudeInstallFallback', { v: install.fallback }));
  }
  return false;
}

async function ensureLaunchPrerequisites(lang) {
  if (!(await ensureClaudeInstalled(lang))) return false;

  await ensureDir(appDir);
  await ensureDir(backupsDir);
  await ensureGlobalClaudeSettings(lang, { quiet: true });

  if ((await listProviders()).length === 0) {
    console.log(t(lang, 'providerSetupRequired'));
    console.log(t(lang, 'providerSetupMenu'));
    console.log(t(lang, 'providerSetupOptional'));
    await mainMenu(lang);
    return false;
  }

  return true;
}

async function runClaude(extraArgs) {
  const current = await getCurrentProvider();
  if (!current) {
    throw new Error('no current provider. run: claudex provider use <name>');
  }

  const settings = providerSettingsPath(current);
  if (!(await exists(settings))) {
    throw new Error(`current provider settings missing: ${settings}`);
  }

  const native = await getNativeConfig();
  const settingsJson = await readJson(settings);
  const auth = readProviderAuth(settingsJson);
  const promptText = extraArgs.filter((value) => typeof value === 'string' && !value.startsWith('-')).join(' ');
  const context = await buildRuntimeNativeContext(current, settings, native, auth, promptText);

  const launchArgs = ['--settings', settings];
  if (native.enabled && shouldInjectNativePrompt(extraArgs)) {
    launchArgs.push('--append-system-prompt', buildNativeRuntimePrompt(context));
  }
  launchArgs.push(...extraArgs);

  await new Promise((resolve, reject) => {
    const child = spawnClaude(launchArgs, {
      stdio: 'inherit',
      env: sanitizedEnv(native)
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`claude exited with code ${code}`));
    });
    child.on('error', reject);
  });

  const nextStepKind = inferStepKind({ taskSignals: context.task_signals, routeDecision: context.route_decision });
  const nextSessionState = {
    last_step_kind: nextStepKind,
    last_task_signals: Array.isArray(context.task_signals?.signalList) ? context.task_signals.signalList : [],
    last_route_decision: context.route_decision || null,
    source_prompt_excerpt: promptText,
    recent_steps: appendSessionStep(context.session_state, {
      step_kind: nextStepKind,
      task_signals: Array.isArray(context.task_signals?.signalList) ? context.task_signals.signalList : [],
      route_decision: context.route_decision || null,
      prompt_excerpt: promptText,
      updated_at: new Date().toISOString()
    })
  };
  await writeSessionStateFile(nextSessionState);
}

async function cmdUpdate(rest) {
  const { flags } = parseFlags(rest);
  const repoUrl = 'git+https://github.com/guihai24/claudex-cli.git#main';
  const fromLocal = typeof flags['from-local'] === 'string' ? flags['from-local'] : '';

  // `claudex-cli` on the npm registry is an unrelated project that happens to
  // share the name (a .claude scaffolder, single `claudex` bin, no `codexx`).
  // Installing it would silently replace this tool. Refuse rather than
  // remove the flag, so anyone with the old README still gets a clear answer.
  if (flags['from-npm']) {
    console.error(
      'claudex update --from-npm is not supported: the "claudex-cli" package on the npm registry\n' +
      'is a different project. This tool is only distributed from GitHub.\n' +
      `Run \`claudex update\` (pulls ${repoUrl}) or \`claudex update --from-local <path>\`.`
    );
    process.exitCode = 1;
    return;
  }

  if (fromLocal) {
    console.log(`Updating from local path: ${fromLocal}`);
    await runProcess('npm', ['i', '-g', fromLocal], process.env);
  } else {
    console.log(`Updating from GitHub: ${repoUrl}`);
    await runProcess('npm', ['i', '-g', repoUrl], process.env);
  }

  // Refresh the shell helpers via the freshly-installed claudex. This MUST run
  // as a NEW process: the current one still holds the old code in memory, so
  // its own injectShellBlock would re-write the previous block. Best-effort —
  // a failure here must not fail the update itself.
  console.log('Refreshing shell helpers...');
  try {
    await runProcess('claudex', ['init'], process.env);
  } catch (err) {
    console.log(`Could not refresh shell helpers automatically (${String(err.message || err)}). Run: claudex init`);
  }
  console.log('Update complete.');
}

async function cmdInit(lang) {
  await ensureDir(appDir);
  await ensureDir(backupsDir);
  await ensureGlobalClaudeSettings(lang);
  const injected = await injectShellBlock();

  console.log(t(lang, 'initialized', { v: appDir }));
  console.log(t(lang, 'shellFile', { v: injected.rc }));
  if (injected.action === 'created') {
    console.log(t(lang, 'helperAdded'));
    console.log(t(lang, 'helperRun', { v: injected.rc }));
  } else if (injected.action === 'updated') {
    console.log(t(lang, 'helperUpdated'));
    console.log(t(lang, 'helperRun', { v: injected.rc }));
  } else {
    console.log(t(lang, 'helperExists'));
  }

  // On Windows the bash/zsh wrapper above never loads in PowerShell, so a bare
  // `claude` there would ignore the current provider. Inject the PowerShell 7
  // analog into $PROFILE as well.
  if (process.platform === 'win32') {
    const ps = await injectPowerShellProfile();
    console.log(t(lang, 'pwshFile', { v: ps.profile }));
    if (ps.action === 'created') {
      console.log(t(lang, 'pwshHelperAdded'));
      console.log(t(lang, 'pwshHelperRun', { v: ps.profile }));
    } else if (ps.action === 'updated') {
      console.log(t(lang, 'pwshHelperUpdated'));
      console.log(t(lang, 'pwshHelperRun', { v: ps.profile }));
    } else {
      console.log(t(lang, 'pwshHelperExists'));
    }
  }

  try {
    const statsCmd = await installStatsCommand();
    console.log(lang === 'zh'
      ? `已安装 /stats 命令：${statsCmd}（在 Claude Code 里输入 /stats 查看用量统计）`
      : `Installed /stats command: ${statsCmd} (type /stats in Claude Code)`);
  } catch {
    // /stats is a convenience; don't fail init if it can't be written.
  }
}

async function pickProvider(lang, promptText) {
  const providers = await listProviders();
  if (providers.length === 0) {
    throw new Error(t(lang, 'noProviders'));
  }

  const current = await getCurrentProvider();
  console.log(t(lang, 'providersAvailable'));
  for (let i = 0; i < providers.length; i += 1) {
    const p = providers[i];
    console.log(`${i + 1}. ${p === current ? '*' : ' '} ${p}`);
  }
  console.log(t(lang, 'backGuide'));
  const chosenRaw = await ask((promptText || t(lang, 'askProvider')));
  const chosen = chosenRaw.trim();
  if (!chosen) throw new Error(t(lang, 'notEnteredProvider'));
  if (isBackInput(chosen)) throw new BackSignal();

  if (/^\d+$/.test(chosen)) {
    const idx = Number(chosen) - 1;
    if (idx < 0 || idx >= providers.length) throw new Error(t(lang, 'providerIndexOutOfRange'));
    return providers[idx];
  }

  if (!providers.includes(chosen)) throw new Error(t(lang, 'providerNotFound', { v: chosen }));
  return chosen;
}

async function resolveProviderArg(input, lang) {
  const chosen = (input || '').trim();
  if (!chosen) return '';
  if (!/^\d+$/.test(chosen)) return chosen;

  const providers = await listProviders();
  const idx = Number(chosen) - 1;
  if (idx < 0 || idx >= providers.length) throw new Error(t(lang, 'providerIndexOutOfRange'));
  return providers[idx];
}

async function cmdProvider(subArgs, lang) {
  const [action, ...rest] = subArgs;
  const { flags, rest: positional } = parseFlags(rest);

  if (action === 'add') {
    let info;
    try {
      info = await promptProviderAdd(flags, lang);
    } catch (err) {
      if (err instanceof BackSignal) {
        console.log(t(lang, 'backDone'));
        return;
      }
      throw err;
    }
    const file = await writeProviderSettings(info);
    if (flags.current || flags['set-current']) await setCurrentProvider(info.name);
    console.log(t(lang, 'saved', { v: file }));
    console.log(`claudex test ${info.name}`);
    console.log(`claudex use ${info.name}`);
    return;
  }

  if (action === 'edit') {
    const target = await resolveProviderArg(positional[0] || flags.name, lang);
    if (!target) throw new Error(t(lang, 'providerUsage'));
    let info;
    try {
      info = await promptProviderEdit(target, flags, lang);
    } catch (err) {
      if (err instanceof BackSignal) {
        console.log(t(lang, 'backDone'));
        return;
      }
      throw err;
    }
    const file = await writeProviderSettings(info);
    console.log(t(lang, 'editedOk', { v: target, file }));
    return;
  }

  if (action === 'list') {
    const providers = await listProviders();
    const current = await getCurrentProvider();
    if (providers.length === 0) {
      console.log(t(lang, 'noProviders'));
      return;
    }
    for (let i = 0; i < providers.length; i += 1) {
      const p = providers[i];
      console.log(`${i + 1}. ${p === current ? '*' : ' '} ${p}`);
    }
    if (!current) {
      console.log(`\n${t(lang, 'noActiveProvider')}`);
    }
    return;
  }

  if (action === 'use') {
    const name = await resolveProviderArg(positional[0], lang);
    if (!name) throw new Error(t(lang, 'useUsage'));
    const file = providerSettingsPath(name);
    if (!(await exists(file))) throw new Error(`provider settings not found: ${file}`);
    await setCurrentProvider(name);
    console.log(t(lang, 'currentProvider', { v: name }));
    const native = await getNativeConfig();
    if (native.enabled) {
      console.log(t(lang, 'nativeInherited', { profile: native.profile }));
    }
    return;
  }

  if (action === 'remove') {
    const name = await resolveProviderArg(positional[0], lang);
    if (!name) throw new Error(t(lang, 'removeUsage'));
    const file = providerSettingsPath(name);
    if (!(await exists(file))) throw new Error(`provider settings not found: ${file}`);

    if (!flags.yes) {
      if (!input.isTTY || flags['no-input'] === true) {
        throw new Error(t(lang, 'nonInteractiveRequiresYes'));
      }
      const ans = (await ask(t(lang, 'removeConfirm', { v: file }))).toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log(t(lang, 'cancelled'));
        return;
      }
    }

    await backupFile(file);
    await fsp.unlink(file);
    const current = await getCurrentProvider();
    if (current === name) await fsp.unlink(currentProviderFile).catch(() => {});
    console.log(t(lang, 'deleted', { v: file }));
    return;
  }

  if (action === 'test') {
    const name = await resolveProviderArg(positional[0], lang);
    if (!name) throw new Error(t(lang, 'testUsage'));
    const result = await testProvider(name);
    console.log(t(lang, 'testOK', { name, status: result.status, protocol: result.protocol || 'unknown' }));
    return;
  }

  throw new Error(t(lang, 'providerUsage'));
}

async function cmdStatus(lang) {
  const current = await getCurrentProvider();
  const providers = await listProviders();
  const native = await getNativeConfig();
  console.log(t(lang, 'currentProvider', { v: current || '(none)' }));
  if (current) {
    const file = providerSettingsPath(current);
    console.log(t(lang, 'currentSettings', { file, state: await exists(file) ? '(exists)' : '(missing)' }));
    if (await exists(file)) {
      try {
        const settings = await readProviderSettings(current);
        console.log(t(lang, 'currentEndpoint', { v: settings.baseUrl || '(unset)' }));
        console.log(t(lang, 'currentModels', {
          haiku: settings.haikuModel || '(unset)',
          sonnet: settings.sonnetModel || '(unset)',
          opus: settings.opusModel || '(unset)'
        }));
      } catch (err) {
        console.log(`⚠️ ${String(err.message || err)}`);
      }
    }
  }
  console.log(t(lang, 'providers', { v: providers.length ? providers.join(', ') : '(none)' }));
  console.log(t(lang, 'nativeStatus', { state: nativeStateLabel(lang, native.enabled) }));
  console.log(t(lang, 'nativeProfile', { profile: native.profile }));
}

async function cmdDoctor(flags, lang) {
  const target = flags.provider || (await getCurrentProvider());
  const native = await getNativeConfig();
  console.log(t(lang, 'doctorTitle'));

  const ver = getClaudeVersion();
  if (ver) {
    console.log(t(lang, 'claudeInstalled', { v: ver }));
  } else {
    console.log(t(lang, 'claudeNotInstalled'));
  }

  const conflicts = [];
  if (process.env.ANTHROPIC_AUTH_TOKEN) conflicts.push('ANTHROPIC_AUTH_TOKEN is set in current shell');
  if (process.env.ANTHROPIC_API_KEY) conflicts.push('ANTHROPIC_API_KEY is set in current shell');
  if (process.env.ANTHROPIC_BASE_URL) conflicts.push('ANTHROPIC_BASE_URL is set in current shell');

  if (conflicts.length) {
    console.log(t(lang, 'envConflicts'));
    for (const c of conflicts) console.log(`  - ${c}`);
    console.log(t(lang, 'fixHint'));
  } else {
    console.log(t(lang, 'envNone'));
  }

  console.log(t(lang, 'nativeDoctorSummary', {
    state: nativeStateLabel(lang, native.enabled),
    profile: native.profile
  }));

  if (!target) {
    console.log(t(lang, 'doctorNoCurrent'));
    return;
  }

  try {
    const result = await testProvider(target);
    console.log(t(lang, 'providerTestOK', { name: target, status: result.status, protocol: result.protocol || 'unknown' }));
  } catch (err) {
    console.log(t(lang, 'providerTestFail', { name: target }));
    console.log(`  ${String(err.message || err)}`);
  }
}

async function configureWizard(lang) {
  await cmdInit(lang);
  let info;
  try {
    info = await promptProviderAdd({}, lang);
  } catch (err) {
    if (err instanceof BackSignal) {
      console.log(t(lang, 'backDone'));
      return;
    }
    throw err;
  }
  const file = await writeProviderSettings(info);
  await setCurrentProvider(info.name);
  console.log(t(lang, 'wizardSaved', { v: file }));
  await askAndRunProviderTest(info.name, lang);
}

function shouldRunTestInput(ansRaw) {
  const ans = (ansRaw || '').trim().toLowerCase();
  return ans === '' || ans === 'y' || ans === 'yes' || ans === '是' || ans === 'ok';
}

async function askAndRunProviderTest(providerName, lang) {
  const ans = await ask(t(lang, 'testNowQ'));
  if (!shouldRunTestInput(ans)) return;
  console.log(t(lang, 'testingNow', { name: providerName }));
  const result = await testProvider(providerName);
  console.log(t(lang, 'testPass', { name: providerName, status: result.status, protocol: result.protocol || 'unknown' }));
}

async function manageProvidersMenu(lang) {
  while (true) {
    console.log(`\n${t(lang, 'manageTitle')}`);
    console.log(t(lang, 'mg1'));
    console.log(t(lang, 'mg2'));
    console.log(t(lang, 'mg3'));
    console.log(t(lang, 'mg4'));
    console.log(t(lang, 'mg5'));
    const choice = await ask(t(lang, 'choose15'));

    try {
      if (choice === '1') {
        await cmdProvider(['list'], lang);
        continue;
      }
      if (choice === '2') {
        const info = await promptProviderAdd({}, lang);
        const file = await writeProviderSettings(info);
        console.log(t(lang, 'saved', { v: file }));
        await askAndRunProviderTest(info.name, lang);
        continue;
      }
      if (choice === '3') {
        const name = await pickProvider(lang, t(lang, 'askEdit'));
        try {
          const info = await promptProviderEdit(name, {}, lang);
          const file = await writeProviderSettings(info);
          console.log(t(lang, 'editedOk', { v: name, file }));
          await askAndRunProviderTest(info.name, lang);
        } catch (err) {
          if (err instanceof BackSignal) {
            console.log(t(lang, 'backDone'));
          } else throw err;
        }
        continue;
      }
      if (choice === '4') {
        const name = await pickProvider(lang, t(lang, 'askDelete'));
        await cmdProvider(['remove', name, '--yes'], lang);
        continue;
      }
      if (choice === '5') return;
      console.log(t(lang, 'invalid15'));
    } catch (err) {
      if (err instanceof BackSignal) {
        console.log(t(lang, 'backDone'));
        continue;
      }
      console.log(t(lang, 'opFailed', { v: String(err.message || err) }));
    }
  }
}


async function nativeMenu(lang) {
  while (true) {
    console.log(`\n${t(lang, 'nativeTitle')}`);
    console.log(t(lang, 'native1'));
    console.log(t(lang, 'native2'));
    console.log(t(lang, 'native3'));
    console.log(t(lang, 'native4'));
    console.log(t(lang, 'native5'));
    console.log(t(lang, 'native6'));
    const choice = await ask(t(lang, 'nativeChoose'));

    try {
      if (choice === '1') {
        await cmdNative(['on'], lang);
        continue;
      }
      if (choice === '2') {
        await cmdNative(['off'], lang);
        continue;
      }
      if (choice === '3') {
        await cmdNative(['status'], lang);
        continue;
      }
      if (choice === '4') {
        await cmdNative(['profile'], lang);
        continue;
      }
      if (choice === '5') {
        await cmdNative(['doctor'], lang);
        continue;
      }
      if (choice === '6') return;
      console.log(t(lang, 'nativeInvalid'));
    } catch (err) {
      if (err instanceof BackSignal) {
        console.log(t(lang, 'backDone'));
        continue;
      }
      console.log(t(lang, 'opFailed', { v: String(err.message || err) }));
    }
  }
}

async function contextUsageMenu(lang) {
  const configFile = path.join(appDir, 'context-usage.json');

  // 读取当前配置
  let enabled = false;
  try {
    if (await exists(configFile)) {
      const data = await readJson(configFile);
      enabled = Boolean(data?.enabled);
    }
  } catch {
    // ignore
  }

  while (true) {
    console.log(`\n${t(lang, 'contextUsageTitle')}`);
    console.log(t(lang, 'contextUsageDesc'));
    console.log('');
    const statusText = enabled ? t(lang, 'contextUsageEnabled') : t(lang, 'contextUsageDisabled');
    console.log(t(lang, 'contextUsageStatus', { status: statusText }));
    console.log('');
    console.log(t(lang, 'contextUsage1'));
    console.log(t(lang, 'contextUsage2'));
    console.log(t(lang, 'contextUsage3'));

    const choice = await ask(t(lang, 'contextUsageChoose'));

    if (choice === '1') {
      try {
        await enableContextUsage();
        await ensureDir(appDir);
        await writeJson(configFile, { enabled: true });
        enabled = true;
        console.log(t(lang, 'contextUsageSaved', { status: t(lang, 'contextUsageEnabled') }));
      } catch (err) {
        console.log(t(lang, 'opFailed', { v: err.message }));
      }
      continue;
    }
    if (choice === '2') {
      try {
        await disableContextUsage();
        await ensureDir(appDir);
        await writeJson(configFile, { enabled: false });
        enabled = false;
        console.log(t(lang, 'contextUsageSaved', { status: t(lang, 'contextUsageDisabled') }));
      } catch (err) {
        console.log(t(lang, 'opFailed', { v: err.message }));
      }
      continue;
    }
    if (choice === '3') {
      return;
    }
    console.log(t(lang, 'contextUsageInvalid'));
  }
}

const STATUSLINE_SCRIPT = `#!/usr/bin/env python3
"""Claude Code statusLine: 显示当前 context 使用百分比。

原理: 读取会话 transcript(JSONL), 反向取最近一次的 context 占用 ——
compact 边界(compactMetadata.postTokens, 压缩后大小)与真实 assistant usage
谁先遇到用谁; usage ≈ input + cache_read + cache_creation_input_tokens。
跳过 token 全为 0 的合成消息(<synthetic>, API 出错时会留下)。
注意: compact 后若直接取最后一条 usage 会穿透到压缩前的旧值, 显示仍是压缩前的占用。

context 窗口上限:
  - 环境变量 CLAUDE_CTX_LIMIT 优先(整数, 如 1000000)
  - 否则: model id 含 "1m" → 1,000,000, 其余 → 200,000
"""
import sys
import json
import os


def context_limit(model_id):
    override = os.environ.get("CLAUDE_CTX_LIMIT")
    if override:
        try:
            return int(override)
        except ValueError:
            pass
    return 1_000_000 if "1m" in model_id else 200_000


def used_tokens(transcript_path):
    """反向扫 transcript, 返回当前 context 占用 token 数。

    compact 边界(compactMetadata.postTokens, 压缩后大小)与真实 usage,
    谁先在反向遍历中出现就用谁:
      - 从未 compact          → 先遇到 usage, 用它
      - compact 后已有新调用  → 先遇到新 usage(已反映压缩后), 用它
      - compact 后还没发消息  → 先遇到 compactMetadata, 用 postTokens
    若取最后一条 usage 会穿透到压缩前的旧值(即原 bug)。全 0 合成消息跳过。
    """
    try:
        with open(transcript_path, encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return 0
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        meta = obj.get("compactMetadata")
        if isinstance(meta, dict) and isinstance(meta.get("postTokens"), int):
            return meta["postTokens"]
        message = obj.get("message")
        if not isinstance(message, dict):
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        total = (usage.get("input_tokens", 0)
                 + usage.get("cache_read_input_tokens", 0)
                 + usage.get("cache_creation_input_tokens", 0))
        if total > 0:  # 跳过全 0 的合成消息
            return total
    return 0


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        print("ctx —")
        return

    model = data.get("model") or {}
    model_id = (model.get("id") or "").lower()
    model_name = model.get("display_name") or model.get("id") or "claude"

    limit = context_limit(model_id)
    used = used_tokens(data.get("transcript_path") or "")
    pct = (used / limit * 100) if limit else 0

    if pct >= 85:
        color = "\\033[91m"   # 亮红: 该 /compact 了
    elif pct >= 60:
        color = "\\033[93m"   # 亮黄: 留意
    else:
        color = "\\033[92m"   # 亮绿: 充裕
    reset = "\\033[0m"
    dim = "\\033[2m"

    bar_len = 10
    filled = min(bar_len, round(pct / 100 * bar_len))
    bar = "█" * filled + "░" * (bar_len - filled)

    print(f"{dim}{model_name}{reset} {color}{bar} {pct:.0f}%{reset} "
          f"{dim}({used // 1000}k/{limit // 1000}k){reset}")


main()
`;

async function enableContextUsage() {
  // 1. 确保脚本目录存在（使用和用户原配置一致的目录）
  const scriptDir = path.join(home, '.claude', 'context-monitor');
  const scriptPath = path.join(scriptDir, 'statusline-context.py');

  await ensureDir(scriptDir);

  // 2. 检查是否已有 statusLine 配置
  const backupFile = globalClaudeSettingsFile + '.claudex-backup';
  let settings = {};
  let hasExistingStatusLine = false;

  if (await exists(globalClaudeSettingsFile)) {
    try {
      settings = await readJson(globalClaudeSettingsFile);
      if (settings.statusLine) {
        hasExistingStatusLine = true;
        // 备份原配置
        await fsp.copyFile(globalClaudeSettingsFile, backupFile);
        console.log(`⚠️  检测到已有上下文显示配置，已备份到: ${backupFile}`);
      }
    } catch {
      settings = {};
    }
  }

  // 3. 写入脚本内容
  await fsp.writeFile(scriptPath, STATUSLINE_SCRIPT, 'utf8');
  await fsp.chmod(scriptPath, 0o755);

  // 4. 写入 statusLine 配置
  settings.statusLine = {
    type: 'command',
    command: `python3 ${scriptPath}`,
    padding: 0
  };

  // 5. 保存配置
  await ensureDir(claudeDir);
  await writeJson(globalClaudeSettingsFile, settings);
}

async function disableContextUsage() {
  // 检查是否有备份文件
  const backupFile = globalClaudeSettingsFile + '.claudex-backup';

  if (await exists(backupFile)) {
    // 如果有备份，恢复备份
    try {
      await fsp.copyFile(backupFile, globalClaudeSettingsFile);
      console.log(`✅ 已从备份恢复原配置: ${backupFile}`);
      // 删除备份文件
      await fsp.unlink(backupFile);
      return;
    } catch (err) {
      console.log(`⚠️  恢复备份失败: ${err.message}，将直接移除 statusLine 配置`);
    }
  }

  // 没有备份或恢复失败，直接移除 statusLine
  if (!(await exists(globalClaudeSettingsFile))) {
    return;
  }

  let settings = {};
  try {
    settings = await readJson(globalClaudeSettingsFile);
  } catch {
    return;
  }

  // 移除 statusLine 配置
  if (settings.statusLine) {
    delete settings.statusLine;
    await writeJson(globalClaudeSettingsFile, settings);
  }
}

async function moreSettingsMenu(lang) {
  while (true) {
    console.log(`\n${t(lang, 'moreTitle')}`);
    console.log(t(lang, 'more1'));
    console.log(t(lang, 'more2'));
    console.log(t(lang, 'more3'));
    console.log(t(lang, 'more4'));
    console.log(t(lang, 'more5'));
    console.log(t(lang, 'more6'));
    const choice = await ask(t(lang, 'choose16more'));

    if (choice === '1') {
      await nativeMenu(lang);
      continue;
    }
    if (choice === '2') {
      await contextUsageMenu(lang);
      continue;
    }
    if (choice === '3') {
      await cmdInit(lang);
      continue;
    }
    if (choice === '4') {
      usage();
      continue;
    }
    if (choice === '5') {
      console.log(`\n${t(lang, 'langTitle')}`);
      console.log(t(lang, 'lang1'));
      console.log(t(lang, 'lang2'));
      console.log(t(lang, 'lang3'));
      while (true) {
        const langChoice = await ask(t(lang, 'langChoose'));
        if (langChoice === '1') {
          const saved = await setLanguage('zh');
          lang = saved;
          console.log(t(lang, 'langSaved', { v: saved }));
          break;
        }
        if (langChoice === '2') {
          const saved = await setLanguage('en');
          lang = saved;
          console.log(t(lang, 'langSaved', { v: saved }));
          break;
        }
        if (langChoice === '3') {
          break;
        }
        console.log(t(lang, 'langInvalid'));
      }
      continue;
    }
    if (choice === '6') return;
    console.log(t(lang, 'invalid16more'));
  }
}

async function mainMenu(lang) {
  while (true) {
    renderBanner(lang);
    console.log('----------------------------------------');
    console.log(t(lang, 'menuTitle'));
    console.log(t(lang, 'm1'));
    console.log(t(lang, 'm2'));
    console.log(t(lang, 'm3'));
    console.log(t(lang, 'm4'));
    console.log(t(lang, 'm5'));
    console.log(t(lang, 'm6'));
    console.log(t(lang, 'm7'));
    console.log(t(lang, 'm8'));
    console.log('----------------------------------------');
    const choice = await ask(t(lang, 'choose18'));

    try {
      if (choice === '1') {
        await configureWizard(lang);
        continue;
      }
      if (choice === '2') {
        await cmdStatus(lang);
        continue;
      }
      if (choice === '3') {
        const name = await pickProvider(lang, t(lang, 'askSwitchTo'));
        await cmdProvider(['use', name], lang);
        continue;
      }
      if (choice === '4') {
        await manageProvidersMenu(lang);
        continue;
      }
      if (choice === '5') {
        console.log('');
        console.log(await runStats([]));
        console.log('');
        continue;
      }
      if (choice === '6') {
        await cmdDoctor({}, lang);
        continue;
      }
      if (choice === '7') {
        await moreSettingsMenu(lang);
        lang = await getLanguage();
        continue;
      }
      if (choice === '8' || choice.toLowerCase() === 'q') {
        console.log(t(lang, 'bye'));
        return;
      }
      console.log(t(lang, 'invalid18'));
    } catch (err) {
      if (err instanceof BackSignal) {
        console.log(t(lang, 'backDone'));
        continue;
      }
      console.log(t(lang, 'execFailed', { v: String(err.message || err) }));
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const lang = await getLanguage();
  const [cmd, ...rest] = argv;
  if (!cmd) {
    if (!(await ensureLaunchPrerequisites(lang))) return;
    await runClaude([]);
    return;
  }

  if (cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === 'menu') {
    if (!(await ensureClaudeInstalled(lang))) return;
    await mainMenu(lang);
    return;
  }

  if (cmd.startsWith('-')) {
    if (!(await ensureLaunchPrerequisites(lang))) return;
    await runClaude(argv);
    return;
  }

  if (['add', 'edit', 'list', 'use', 'remove', 'test', 'provider'].includes(cmd) &&
      (rest.includes('--help') || rest.includes('-h'))) {
    usage();
    return;
  }

  if (cmd === 'add') {
    await cmdProvider(['add', ...rest], lang);
    return;
  }

  if (cmd === 'edit') {
    await cmdProvider(['edit', ...rest], lang);
    return;
  }

  if (cmd === 'list') {
    await cmdProvider(['list', ...rest], lang);
    return;
  }

  if (cmd === 'use') {
    await cmdProvider(['use', ...rest], lang);
    return;
  }

  if (cmd === 'remove') {
    await cmdProvider(['remove', ...rest], lang);
    return;
  }

  if (cmd === 'test') {
    const [name] = rest;
    const provider = (await resolveProviderArg(name || '', lang)) || (await getCurrentProvider());
    if (!provider) throw new Error('usage: claudex test [name]');
    const result = await testProvider(provider);
    console.log(t(lang, 'testOK', { name: provider, status: result.status, protocol: result.protocol || 'unknown' }));
    return;
  }

  if (cmd === 'init') {
    await cmdInit(lang);
    return;
  }

  if (cmd === 'provider') {
    await cmdProvider(rest, lang);
    return;
  }

  if (cmd === 'status') {
    await cmdStatus(lang);
    return;
  }

  if (cmd === 'native') {
    await cmdNative(rest, lang);
    return;
  }

  if (cmd === 'lang') {
    const next = normalizeLanguage(rest[0] || '');
    if (!next) throw new Error('usage: claudex lang <zh|en|中文|英文>');
    const saved = await setLanguage(next);
    console.log(t(saved, 'langSaved', { v: saved }));
    return;
  }

  if (cmd === 'update') {
    await cmdUpdate(rest);
    return;
  }

  if (cmd === 'doctor') {
    const { flags } = parseFlags(rest);
    await cmdDoctor(flags, lang);
    return;
  }

  if (cmd === 'run') {
    if (!(await ensureLaunchPrerequisites(lang))) return;
    await runClaude(rest);
    return;
  }

  if (cmd === 'stats') {
    if (rest.includes('--help') || rest.includes('-h')) {
      statsUsage();
      return;
    }
    console.log(await runStats(rest));
    return;
  }

  throw new Error(`unknown command: ${cmd}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .finally(closeReadline)
    .catch((err) => {
      console.error(`Error: ${err.message || err}`);
      process.exit(1);
    });
}
