const TXT = {
  zh: {
    // banner / general
    bannerSub: 'Codex Provider Switching Console',
    bye: '👋 已退出。',
    opFailed: '⚠️ 操作失败: {v}',

    // status / list
    currentProvider: '📌 当前 Codex 服务商: {v}',
    providerMissing: '⚠️ 当前指针 {v} 没有对应配置。请运行: codexx use <name>',
    currentEndpoint: '   接入点: {v}',
    currentModel: '   模型: {v}',
    currentWireApi: '   Wire API: {v}',
    currentAuthMode: '   鉴权: {v}',
    noActiveProvider: '⚠️ 当前未设置 Codex 服务商。请执行: codexx use <name>',
    providersHeader: 'Codex 服务商列表:',
    providersEmpty: '尚未配置任何 Codex 服务商。运行 codexx add 添加。',
    activeMark: ' (当前)',
    codexCliVersion: 'Codex CLI: {v}',
    codexCliMissing: 'Codex CLI: 未安装',
    codexAppRunning: 'Codex 桌面 App: 运行中 (PID {v})',
    codexAppNotRunning: 'Codex 桌面 App: 未运行',
    configDriftClean: 'Config drift: 无',
    configDrifted: 'Config drift: 检测到 {v}',

    // add wizard
    askName: '服务商名称 (例如 openrouter): ',
    askBaseUrl: 'Base URL: ',
    askApiKey: 'API Key: ',
    askModel: 'Model: ',
    askWireApi: 'Wire API (chat/responses) [responses]: ',
    askReasoning: 'Reasoning effort (low/medium/high) [high]: ',
    addedOk: '✅ 已添加服务商: {v}',
    askConfirm: '继续吗? [y/N]: ',
    canceled: '已取消。',
    nonInteractiveRequiresYes: '非交互模式需要显式加 --yes。',

    // remove
    removeConfirm: '将删除服务商 {v}。继续吗? [y/N]: ',
    removedOk: '✅ 已删除服务商: {v}',
    removeActive: '⚠️ 不能删除当前激活的服务商。请先 codexx use <other>。',

    // use
    switchedTo: '✅ 已切换到服务商: {v}',
    switchEndpoint: '   接入点: {v}',
    switchModel: '   模型: {v}',
    backupAt: '   备份: {v}',
    chatgptBackupAt: '⚠️ 检测到 ChatGPT 订阅登录，tokens 已备份到: {v}',
    chatgptRestoreHint: '   恢复方法: codexx restore-chatgpt',
    restartCodexHint: 'ℹ️ 如果 Codex CLI / 桌面 App / VS Code 扩展正在运行，需重启以应用新配置。',
    driftDetected: '⚠️ 检测到外部修改: {v}',
    driftPrompt: '继续切换会保留外部修改。继续吗? [y/N]: ',
    driftNonInteractive: '检测到外部修改。非交互模式请使用 --force，或先运行 codexx reconcile --yes。',

    // test
    testNowQ: '是否立即测试连接？(Y/n): ',
    testRunning: '正在测试 {v} ...',
    testOk: '✅ 测试通过: {v} (HTTP {status}, {protocol}, {ms}ms)',
    testFail: '❌ 测试失败: {v} ({reason})',
    testNoModel: '⚠️ 该服务商未设置 model，跳过模型联通性，仅探测 base_url 可达性。',

    // revert / restore
    revertConfirm: '将恢复 ~/.codex/ 到 codexx 首次使用前的状态。继续吗? [y/N]: ',
    revertNoSnapshot: '⚠️ 未找到 pre-claudex 快照，无法 revert。',
    revertedOk: '✅ 已 revert 到原生状态。',
    restoreConfirm: '将用备份 {v} 覆盖 ~/.codex/ 的 config.toml / auth.json / .env (当前状态会先备份)。继续吗? [y/N]: ',
    restoreOk: '✅ 已恢复备份: {v}',
    snapshotTaken: '✅ 快照已创建: {v}',
    snapshotExisted: 'ℹ️ pre-claudex 快照已存在 (首次 use 时自动创建)。',

    // audit
    auditEmpty: '审计日志为空。',
    auditHeader: '最近 {v} 条审计事件:',

    // init
    initOk: '✅ codexx 初始化完成。',
    codexNotInstalled: '⚠️ 未检测到 Codex CLI。安装方法见: https://developers.openai.com/codex',
    codexOldVersion: 'ℹ️ Codex CLI 版本 {v} < v0.130；建议升级以获得 config 热重载能力。',

    // menu
    // Skeleton aligned with claudex:
    // setup/add → status → switch → manage → [platform] → doctor → more → exit
    // codexx has no token-stats platform slot, so doctor sits at 5.
    menuTitle: 'codexx 主菜单',
    menuChoose: '请选择 (1-7): ',
    menuInvalid: '输入无效，请输入 1-7。',
    m1: '1. 添加 Codex 服务商',
    m2: '2. 查看当前状态',
    m3: '3. 切换服务商',
    m4: '4. 管理服务商',
    m5: '5. 诊断 (doctor)',
    m6: '6. 更多设置',
    m7: '7. 退出',
    mmgChoose: '请选择 (1-5): ',
    mmgInvalid: '输入无效，请输入 1-5。',
    mmg1: '1. 列出服务商',
    mmg2: '2. 新增服务商',
    mmg3: '3. 编辑服务商',
    mmg4: '4. 删除服务商',
    mmg5: '5. 返回',
    moreChoose: '请选择 (1-3): ',
    moreInvalid: '输入无效，请输入 1-3。',
    more1: '1. 切换语言',
    more2: '2. 初始化 (init)',
    more3: '3. 返回',
    legacyNativeAgentsCleaned: '🧹 已清理旧版 codexx Native 写入的 AGENTS.md 段落',
    legacyNativeStateRemoved: '🧹 已删除旧版 codex-native.json 状态文件',

    // login/logout wrappers
    loginWarnOAuth: '⚠️ 你即将走 codex login OAuth 流程，会覆盖当前 auth.json。',
    loginContinue: '继续吗? [y/N]: ',
    logoutWarnClaudex: '⚠️ 当前 auth.json 是 codexx 管理的 API Key 模式，logout 会清空。',
    logoutContinue: '继续吗? [y/N]: ',
    appLaunching: '正在启动 Codex 桌面 App...',

    // edit
    editIntro: '正在编辑 {v}（每项回车保留原值，输入新值则替换）:',
    editCurrent: '当前',
    editUnset: '(未设)',
    editNewOrKeep: '新值 (回车保留{hint})',
    editNoChanges: 'ℹ️ 没有任何字段改动，未保存。',
    editedOk: '✅ 已更新 {v}: {fields}',
    editReapplying: '🔄 该服务商当前激活，重新应用配置到 ~/.codex/...',
    editReapplied: '✅ 已重新应用',
    editNotActiveHint: 'ℹ️ {v} 不是当前激活的服务商，改动已存到 provider 文件；下次 codexx use {v} 时生效。',
    editPickPrompt: '请输入要编辑的服务商序号或名称: ',
    removePickPrompt: '请输入要删除的服务商序号或名称: ',
    askSwitchTo: '请输入要切换到的服务商序号或名称: ',
    langPrompt: '请输入语言 (zh/en): ',

    // common
    notImplemented: '⚠️ 该命令尚未实现 (将在后续里程碑提供)。',
    missingArg: '⚠️ 缺少参数: {v}',
    invalidArg: '⚠️ 参数无效: {v}',

    // cross-provider resume (codexx --resume)
    resumeHeader: 'Codex 会话记录（{v}，跨全部 provider，默认隐藏 subagent）。注: codexx resume 只列当前 provider:',
    resumeNone: '当前目录（{v}）暂无 Codex 主会话记录。',
    resumePrompt: '输入序号恢复会话（1-{v}，直接回车取消）: ',
    resumeListOnly: 'ℹ️ 非交互模式：仅列出。要直接恢复某条，请用: codexx resume <id>',
    resumeCrossProvider: '📌 该会话创建于 provider {v}，将改用当前 provider（{v2}）继续',

    // help (rendered in usage())
    usageHeader: 'codexx — 切换 OpenAI Codex 服务商，体感与原生 codex 一致',
    usageRun: '日常启动:',
    usageMgmt: '配置管理:',
    usageDiag: '诊断与恢复:',
    usageEsc: '透传 codex 原生命令:'
  },

  en: {
    bannerSub: 'Codex Provider Switching Console',
    bye: '👋 Bye.',
    opFailed: '⚠️ Operation failed: {v}',

    currentProvider: '📌 Current Codex provider: {v}',
    providerMissing: '⚠️ Current pointer {v} has no provider metadata. Run: codexx use <name>',
    currentEndpoint: '   Endpoint: {v}',
    currentModel: '   Model: {v}',
    currentWireApi: '   Wire API: {v}',
    currentAuthMode: '   Auth: {v}',
    noActiveProvider: '⚠️ No active Codex provider. Run: codexx use <name>',
    providersHeader: 'Codex providers:',
    providersEmpty: 'No Codex providers configured. Run codexx add to add one.',
    activeMark: ' (active)',
    codexCliVersion: 'Codex CLI: {v}',
    codexCliMissing: 'Codex CLI: not installed',
    codexAppRunning: 'Codex Desktop App: running (PID {v})',
    codexAppNotRunning: 'Codex Desktop App: not running',
    configDriftClean: 'Config drift: none',
    configDrifted: 'Config drift: detected in {v}',

    askName: 'Provider name (e.g. openrouter): ',
    askBaseUrl: 'Base URL: ',
    askApiKey: 'API Key: ',
    askModel: 'Model: ',
    askWireApi: 'Wire API (chat/responses) [responses]: ',
    askReasoning: 'Reasoning effort (low/medium/high) [high]: ',
    addedOk: '✅ Added provider: {v}',
    askConfirm: 'Continue? [y/N]: ',
    canceled: 'Canceled.',
    nonInteractiveRequiresYes: 'Non-interactive mode requires --yes.',

    removeConfirm: 'Remove provider {v}. Continue? [y/N]: ',
    removedOk: '✅ Removed provider: {v}',
    removeActive: '⚠️ Cannot remove the currently active provider. Switch first: codexx use <other>.',

    switchedTo: '✅ Switched to provider: {v}',
    switchEndpoint: '   Endpoint: {v}',
    switchModel: '   Model: {v}',
    backupAt: '   Backup: {v}',
    chatgptBackupAt: '⚠️ Detected ChatGPT OAuth login. Tokens backed up to: {v}',
    chatgptRestoreHint: '   Restore: codexx restore-chatgpt',
    restartCodexHint: 'ℹ️ Restart any running Codex CLI / Desktop App / VS Code extension to pick up the new config.',
    driftDetected: '⚠️ External modifications detected in: {v}',
    driftPrompt: 'Switching will preserve external modifications. Continue? [y/N]: ',
    driftNonInteractive: 'External modifications detected. In non-interactive mode use --force or run codexx reconcile --yes first.',

    testNowQ: 'Test connection now? (Y/n): ',
    testRunning: 'Testing {v} ...',
    testOk: '✅ Test OK: {v} (HTTP {status}, {protocol}, {ms}ms)',
    testFail: '❌ Test failed: {v} ({reason})',
    testNoModel: '⚠️ Provider has no model set; probing base_url reachability only.',

    revertConfirm: 'This will restore ~/.codex/ to its pre-claudex state. Continue? [y/N]: ',
    revertNoSnapshot: '⚠️ No pre-claudex snapshot found; cannot revert safely.',
    revertedOk: '✅ Reverted to native state.',
    restoreConfirm: 'This will overwrite config.toml / auth.json / .env in ~/.codex/ from backup {v} (current state is backed up first). Continue? [y/N]: ',
    restoreOk: '✅ Restored backup: {v}',
    snapshotTaken: '✅ Snapshot created: {v}',
    snapshotExisted: 'ℹ️ pre-claudex snapshot already exists (auto-taken on first use).',

    auditEmpty: 'Audit log is empty.',
    auditHeader: 'Last {v} audit events:',

    initOk: '✅ codexx initialized.',
    codexNotInstalled: '⚠️ Codex CLI not found. Install: https://developers.openai.com/codex',
    codexOldVersion: 'ℹ️ Codex CLI {v} < v0.130; consider upgrading for config hot-reload.',

    // menu
    // Skeleton aligned with claudex (no token-stats slot on codexx).
    menuTitle: 'codexx Main Menu',
    menuChoose: 'Choose (1-7): ',
    menuInvalid: 'Invalid choice. Enter 1-7.',
    m1: '1. Add a Codex provider',
    m2: '2. Show current status',
    m3: '3. Switch provider',
    m4: '4. Manage providers',
    m5: '5. Diagnose (doctor)',
    m6: '6. More settings',
    m7: '7. Exit',
    mmgChoose: 'Choose (1-5): ',
    mmgInvalid: 'Invalid choice. Enter 1-5.',
    mmg1: '1. List providers',
    mmg2: '2. Add a provider',
    mmg3: '3. Edit a provider',
    mmg4: '4. Remove a provider',
    mmg5: '5. Back',
    moreChoose: 'Choose (1-3): ',
    moreInvalid: 'Invalid choice. Enter 1-3.',
    more1: '1. Switch language',
    more2: '2. Initialise (init)',
    more3: '3. Back',
    legacyNativeAgentsCleaned: '🧹 Removed leftover codexx Native block from AGENTS.md',
    legacyNativeStateRemoved: '🧹 Removed leftover codex-native.json state file',

    // login/logout wrappers
    loginWarnOAuth: '⚠️ codex login will overwrite the current auth.json.',
    loginContinue: 'Continue? [y/N]: ',
    logoutWarnClaudex: '⚠️ auth.json is currently codexx-managed apikey mode; logout will clear it.',
    logoutContinue: 'Continue? [y/N]: ',
    appLaunching: 'Launching Codex Desktop App...',

    // edit
    editIntro: 'Editing {v} (press Enter to keep, type new value to replace):',
    editCurrent: 'current',
    editUnset: '(unset)',
    editNewOrKeep: 'new value (Enter to keep{hint})',
    editNoChanges: 'ℹ️ No fields changed; nothing saved.',
    editedOk: '✅ Updated {v}: {fields}',
    editReapplying: '🔄 Provider is currently active; re-applying to ~/.codex/...',
    editReapplied: '✅ Re-applied',
    editNotActiveHint: 'ℹ️ {v} is not the active provider; changes saved to provider file and will take effect on next codexx use {v}.',
    editPickPrompt: 'Enter provider index or name to edit: ',
    removePickPrompt: 'Enter provider index or name to remove: ',
    askSwitchTo: 'Enter provider index or name to switch to: ',
    langPrompt: 'Enter language (zh/en): ',

    notImplemented: '⚠️ Not yet implemented (coming in a later milestone).',
    missingArg: '⚠️ Missing argument: {v}',
    invalidArg: '⚠️ Invalid argument: {v}',

    // cross-provider resume (codexx --resume)
    resumeHeader: 'Codex sessions in {v} (across ALL providers; subagents hidden by default). Note: `codexx resume` lists only the current provider:',
    resumeNone: 'No Codex main sessions recorded for this directory ({v}).',
    resumePrompt: 'Enter a number to resume (1-{v}, empty to cancel): ',
    resumeListOnly: 'ℹ️ Non-interactive: list only. To resume one directly: codexx resume <id>',
    resumeCrossProvider: '📌 Session was created under provider {v}; continuing with the active provider ({v2})',

    usageHeader: 'codexx — switch OpenAI Codex providers; daily UX matches native codex',
    usageRun: 'Run codex:',
    usageMgmt: 'Manage providers:',
    usageDiag: 'Diagnose & recover:',
    usageEsc: 'Passthrough codex commands:'
  }
};

export function t(lang, key, vars = {}) {
  const bundle = TXT[lang] || TXT.en;
  let s;
  if (bundle[key] !== undefined) s = bundle[key];
  else if (TXT.en[key] !== undefined) s = TXT.en[key];
  else {
    // Key missing in every bundle — show an unambiguous placeholder
    // (don't return the raw key, which can look like a stray code to users).
    s = `[?${key}?]`;
  }
  if (typeof s !== 'string') return `[?${key}?]`;
  for (const [k, v] of Object.entries(vars)) {
    s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

export function knownLanguages() {
  return Object.keys(TXT);
}
