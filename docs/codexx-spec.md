# codexx Specification

Complete specification for `codexx`, a wrapper CLI that brings claudex-style provider management to OpenAI Codex (CLI + IDE extension + Desktop App).

## 1. Background and Goals

### Why

Switching Codex providers today requires hand-editing `~/.codex/config.toml` (TOML format) and ensuring an API key reaches the running process via environment variables, shell rc files, or `codex login`. This is friction-heavy and error-prone. Users with multiple providers (OpenAI, OpenRouter, Azure, internal proxies) accumulate dead config sections and lose track of which endpoint they're talking to.

`claudex` already solved this problem for Claude Code. `codexx` brings the same UX to Codex: one command to switch, persistent across sessions, no manual file editing.

### Goals

1. Single command to switch Codex provider; persistent across CLI + IDE extension + Desktop App.
2. Symmetric command surface with `claudex` (`codexx` ↔ `claudex`, `codexx use` ↔ `claudex use`, etc.).
3. Native experience: daily codex usage stays identical to native — no wrapper friction.
4. Safe writes: never break user's existing config.toml content (comments, MCP, plugins, project trusts).
5. Reversible: one command to fully revert to pre-codexx state.
6. Coexist with ChatGPT subscription login (don't silently destroy OAuth tokens).
7. Diagnostics: `codexx doctor` surfaces config drift, conflicts, hot-reload needs.

### Non-goals

- Fix Codex Desktop App's model picker UI bug for custom providers (upstream issue).
- Support `requires_openai_auth = false` providers in MVP (deferred to v2).
- Custom MCP server management (`codex mcp` is canonical).
- Encrypted credential storage in MVP (chmod 600 only; encrypted backups in v2).
- First-class Linux / Windows support in MVP (best-effort; macOS first).

## 2. User Stories

### S1 — First-time setup

```bash
$ npm i -g claudex-cli
$ codexx init                                # creates state dir, checks codex install
$ codexx add
> Name: openrouter
> Base URL: https://openrouter.ai/api/v1
> API key: sk-or-v1-...
> Model: anthropic/claude-sonnet-4.5
> Wire API (chat/responses) [chat]:
Provider 'openrouter' added.
$ codexx use openrouter
Switched to 'openrouter'
  Endpoint: https://openrouter.ai/api/v1
  Model: anthropic/claude-sonnet-4.5
$ codexx                                     # launches codex with openrouter
```

### S2 — Daily provider switch

User has 3 providers, switches between them about 5 times a day.

```bash
$ codexx use openai-direct
$ codexx
$ codexx use openrouter
$ codexx
```

### S3 — Coexist with ChatGPT subscription

User has logged into ChatGPT via `codex login`. They also want to use codexx for an internal proxy.

```bash
$ codexx use internal-proxy
Detected ChatGPT OAuth tokens in ~/.codex/auth.json.
Backing up to ~/.config/claudex-cli/codex-backups/2026-05-17T10-00-00/auth.json
Continue? [y/N]: y
Switched to 'internal-proxy'. Run 'codexx restore-chatgpt' to go back.
```

### S4 — Use Codex Desktop App with codexx provider

User clicks Codex App in Dock after running `codexx use openrouter`.

Outcome: Desktop App routes requests to openrouter endpoint. UI may show "Custom" in the model picker (Codex upstream cosmetic issue, unrelated to codexx).

### S5 — Diagnose a broken state

```bash
$ codexx doctor
codex CLI: 0.130.2 (pass)
Current provider: openrouter (pass)
Config drift detected (fail)
  config.toml has been modified since last codexx write.
  Likely cause: 'codex mcp add' was run.
  Fix: codexx reconcile
Codex Desktop App is running (warn)
  Restart to pick up provider changes.
Connectivity: OK, HTTP 200, 312ms (pass)
```

### S6 — Revert to native

```bash
$ codexx revert
This will:
  - Restore ~/.codex/config.toml to pre-codexx state
  - Restore ~/.codex/auth.json to pre-codexx state
  - Remove ~/.codex/AGENTS.md native context section (if injected)
  - Preserve codex-backups/ (5 backups, 240 KB)
Continue? [y/N]: y
Reverted.

$ npm uninstall -g claudex-cli
```

### S7 — Recover from external state changes

User runs `codex login` (which resets auth.json). codexx detects drift on next launch.

```bash
$ codexx
Detected auth.json was modified externally (auth_mode = "chatgpt").
codexx state believes provider = 'openrouter' (apikey mode).
Choose: [r] restore codexx state | [a] accept external change | [b] back to menu
```

## 3. CLI Surface

### 3.1 Dispatch rules

- If `argv[0]` in CLAUDEX_OWNED: route to local handler.
- Elif `argv[0] == "--"`: spawn `codex` with `argv[1:]`.
- Else: preflight + spawn `codex argv`.

CLAUDEX_OWNED:

```
init, menu, add, list, use, remove, test, status, doctor,
lang, update, snapshot, restore, revert, audit,
reconcile, restore-chatgpt
```

Conflicts with codex subcommands: only `update`. Resolution: `codexx update` is claudex self-update; `codexx -- update` passes through to `codex update`.

### 3.2 Commands

#### `codexx init`

- Behavior:
  1. Create `~/.config/claudex-cli/codex-*` directories.
  2. Detect codex install; recommend install if missing.
  3. Check codex version; warn if < v0.130 (hot-reload missing).
  4. Optionally inject shell alias (interactive prompt).
- Exit: 0 on success; 1 if codex install required and user declines.
- Side effects: codexx state dirs, optional shell rc append.

#### `codexx add [flags]`

- Synopsis: `codexx add [--name N] [--base-url U] [--api-key K] [--model M] [--wire-api chat|responses] [--reasoning-effort low|medium|high]`
- Behavior:
  1. Prompt for missing fields if interactive.
  2. Validate: `name` not in RESERVED, `base_url` is URL, `api_key` non-empty.
  3. Write to `~/.config/claudex-cli/codex-providers/<name>.json` (chmod 600).
  4. Do NOT modify `~/.codex/` at this point.
- Exit: 0 / 2 (validation error).

#### `codexx list`

Print all known codexx providers, marking the active one.

#### `codexx edit <name|index> [flags]`

- Synopsis: `codexx edit <name> [--base-url U] [--api-key K] [--model M] [--wire-api chat|responses] [--reasoning-effort low|medium|high]`
- Behavior:
  1. Resolve name (or index from `list`).
  2. Read existing provider metadata.
  3. **Non-interactive (stdin not a TTY)**: apply only the fields passed as flags; every other field keeps its current value. No prompts.
  4. **Interactive (TTY)**: walk every editable field, showing the current value (api_key masked as `sk-xxxx...last4`); Enter keeps, new value replaces. Flags pre-fill (skip prompt for that field).
  5. Validate the merged result (same `validateProviderShape` as `add`).
  6. `base_url` is auto-normalised via `normalizeBaseUrl` (bare domain → append `/v1`).
  7. Save to `~/.config/claudex-cli/codex-providers/<name>.json` (chmod 600), stamp `updated_at`.
  8. If the edited provider is currently active, automatically call `applyProviderSwitch` to push changes into `~/.codex/config.toml` + `auth.json` + `.env`. Otherwise print a hint that changes will take effect on next `codexx use`.
- Exit: 0 / 2 (validation error) / 1 (filesystem error during re-apply).
- Immutable fields (`name`, `schema_version`, `created_at`) are silently ignored if passed in.

#### `codexx use <name|index>`

- Behavior:
  1. Resolve name (or index from `list`).
  2. `ensurePreClaudexSnapshot()` (idempotent).
  3. `detectDrift()`; if drifted, prompt user (skip with `--force`).
  4. Detect ChatGPT OAuth in auth.json; back up if present (prompt unless `--yes`).
  5. Acquire file lock.
  6. Write `config.toml` (surgical) + `auth.json` + `~/.codex/.env` (atomic triple-write with rollback chain).
  7. Verify post-write; release lock.
  8. Print active state banner.
- Exit: 0 / 1 (drift refused) / 2 (validation) / 3 (filesystem error).

#### `codexx remove <name|index> [--yes]`

- Behavior:
  1. If currently active: refuse unless `--switch-to=<other>` given.
  2. Remove `<name>.json` from codex-providers dir.
  3. Remove `[model_providers.claudex-<name>]` section from config.toml if present.

#### `codexx test [name|index]`

- Behavior: HTTP request to base_url + minimal completion; report status and latency.
- Exit: 0 on HTTP 200, 1 on any error.

#### `codexx status`

Output:

```
Current Codex provider: openrouter
Endpoint: https://openrouter.ai/api/v1
Model: anthropic/claude-sonnet-4.5
Wire API: chat
Codex CLI: 0.130.2
Codex Desktop: running (PID 12345)
Auth mode: apikey (claudex managed)
Config drift: none
```

#### `codexx doctor [--provider <name>]`

Run comprehensive diagnostics. Output: list of checks with pass/warn/fail and fix hints. See §5.4 for the check matrix.

#### `codexx menu`

Interactive menu, parallel to `claudex menu`.

#### `codexx native on | off | status | profile [name] | doctor`

> **Removed.** Codexx Native (AGENTS.md injection) was deleted. Use `claudex native` for Claude-side Native mode only. `codexx init` scrubs leftover AGENTS.md blocks and `codex-native.json` from older installs.


- `on`: inject native context into `~/.codex/AGENTS.md` within delimiters; record in `codex-native.json`.
- `off`: remove delimited section from AGENTS.md; clean state.
- `status`: print current state.
- `profile [name]`: select `native-first` / `balanced` / `cost-first`.
- `doctor`: native-specific checks.

#### `codexx snapshot`

Explicitly capture a snapshot (in addition to the automatic pre-claudex snapshot on first use).

#### `codexx restore <backup-id|latest>`

Restore both config.toml and auth.json from a specific backup.

#### `codexx revert [--yes] [--preserve-backups | --no-preserve-backups]`

Full revert to pre-codexx state. Restores config.toml, auth.json, removes AGENTS.md delimited section.

#### `codexx audit [--tail N]`

Print audit log entries (JSONL).

#### `codexx reconcile`

Resolve config drift: present diff between codexx state and current files; offer merge strategies.

#### `codexx restore-chatgpt`

Restore ChatGPT OAuth tokens from the most recent backup.

#### `codexx update [--from-local <path>]`

Update codexx itself. Use `codexx -- update` to passthrough to `codex update`.

#### `codexx -- <args>`

Force passthrough: spawn `codex <args>` skipping any claudex-owned keyword matching.

#### `codexx` (no claudex-owned subcommand)

Default codex passthrough:

1. Resolve active provider; refuse if none.
2. `preflight()`.
3. env strip + spawn codex.
4. Optional one-line banner (suppress via `--no-banner` or `CODEXX_QUIET=1`).

### 3.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic error |
| 2 | Validation error (bad args, missing required) |
| 3 | Filesystem error (permission denied, disk full) |
| 4 | Drift detected; user refused to proceed |
| 5 | Conflict with running codex process |
| 130 | Interrupted (Ctrl-C) |

## 4. File Contracts

### 4.1 codexx provider metadata

Path: `~/.config/claudex-cli/codex-providers/<name>.json`

```typescript
interface CodexProvider {
  schema_version: 1;
  name: string;                            // matches filename; ^[a-z0-9][a-z0-9_-]*$, max 64 chars (underscores allowed for parity with claudex naming)
  base_url: string;                        // full URL, must start with http:// or https://
  api_key: string;                         // plaintext, chmod 600 enforced
  model: string;
  wire_api: "chat" | "responses";          // default "chat"
  model_reasoning_effort?: "low" | "medium" | "high";
  http_headers?: Record<string, string>;   // static only; no env_http_headers
  disable_response_storage?: boolean;
  created_at: string;                      // ISO 8601
  last_used_at?: string;
}
```

Invariants:

- File mode = 0600.
- `name` matches the file basename without `.json`.
- `name` NOT in RESERVED (see §4.6).

### 4.2 codexx state files

`~/.config/claudex-cli/codex-current-provider`: single line containing provider name, or empty if none active.

`~/.config/claudex-cli/codex-native.json`:

```typescript
{
  schema_version: 1,
  enabled: boolean,
  profile: "native-first" | "balanced" | "cost-first",
  last_injected_hash: string | null,       // sha256 of AGENTS.md native section content
}
```

`~/.config/claudex-cli/codex-last-known-hashes.json`:

```typescript
{
  config_toml_hash: string,
  auth_json_hash: string,
  agents_md_hash: string | null,
  recorded_at: string,
}
```

### 4.3 `~/.codex/config.toml` — claudex-owned section schema

```toml
# claudex-cli managed BEGIN — provider=<name> schema=v1 ts=<ISO 8601>
[model_providers.claudex-<name>]
name = "<name>"
base_url = "<base_url>"
wire_api = "chat"                           # or "responses"
requires_openai_auth = true                 # MANDATORY — enables AuthManager path
env_key = "OPENAI_API_KEY"                  # MANDATORY — pairs with auth.json
# claudex-cli managed END
```

Top-level keys (when codexx is active):

```toml
model = "<active provider model>"
model_provider = "claudex-<name>"
```

Invariants:

- BEGIN/END markers MUST surround every claudex-owned section.
- claudex NEVER modifies bytes outside its marker-delimited sections, except for the top-level `model` and `model_provider` lines.
- Reserved provider ids (§4.6) are NEVER written.
- Section ids always have the `claudex-` prefix.

### 4.4 `~/.codex/auth.json` — claudex-owned schema

```json
{
  "OPENAI_API_KEY": "<active provider's api_key>",
  "auth_mode": "apikey",
  "_claudex_managed": true,
  "_claudex_provider": "<name>",
  "_claudex_ts": "<ISO 8601>"
}
```

Invariants:

- File mode = 0600.
- Codex's typed AuthDotJson struct silently drops `_claudex_*` fields on its own writes — drift detection compensates by reading our last-known hash.
- When ChatGPT OAuth tokens are present in auth.json, codexx backs them up before overwriting (§5.3).

### 4.5 `~/.codex/AGENTS.md` — native context delimiters

```markdown
<!-- claudex-cli native context BEGIN — managed automatically, do not edit -->
<...injected runtime context...>
<!-- claudex-cli native context END -->
```

Invariants:

- Section is only present when `native.enabled = true`.
- `native off` removes BEGIN→END block (inclusive) and trailing blank line.
- Content outside markers is byte-preserved.
- If user has tampered with content inside markers, `native off` still removes the entire block; `native on` overwrites it (with audit log entry).

### 4.5b `~/.codex/.env` — env-injection for GUI-launched codex

```
# claudex-cli managed BEGIN — do not edit between markers
OPENAI_API_KEY=<active provider's api_key>
# claudex-cli managed END
```

Why this file exists: Codex's `arg0_dispatch_or_else` (entry point shared by CLI, Desktop App, and IDE extension) calls `dotenvy::from_path_iter(~/.codex/.env)` before Tokio starts and `set_var`s each `KEY=VAL` into the process env. For custom `[model_providers.X]` providers with `env_key = "OPENAI_API_KEY"`, Codex's auth flow reads `std::env::var("OPENAI_API_KEY")` and does **not** fall back to `auth.json`'s `OPENAI_API_KEY` field. macOS GUI launches don't inherit shell env, so `.env` is the only env source the App can rely on.

Invariants:

- File mode = 0600.
- Marker-delimited block managed by codexx; content outside markers is byte-preserved.
- Keys other than `OPENAI_API_KEY` may be added inside the block in future (e.g. `OPENAI_BASE_URL` for fine-grained overrides) but only `OPENAI_API_KEY` is written today.
- `codexx use` writes the active provider's `api_key` here as part of the atomic triple-write (auth.json → .env → config.toml).
- `codexx revert` restores `.env` from the pre-claudex snapshot (or deletes it if snapshot had none).
- If the marker block is the only content, `clearClaudexEnv` deletes the file entirely.

### 4.6 Reserved provider ids

```
openai
oss
ollama
ollama-chat
lmstudio
amazon-bedrock
```

Tracked from upstream `RESERVED_MODEL_PROVIDER_IDS`. `codexx add` refuses any name in this list. Names with the `claudex-` prefix are reserved for codexx's own use.

### 4.7 Snapshot directory

Path: `~/.config/claudex-cli/codex-snapshot/pre-claudex/`

```
pre-claudex/
  config.toml          # exact byte copy before first codexx use
  auth.json            # exact byte copy (may be absent if user had no auth.json)
  AGENTS.md            # exact byte copy (may be absent)
  manifest.json        # {ts, codex_version, codexx_version, hashes}
```

The snapshot is created once at first `codexx use`. Subsequent `use` calls do not overwrite it. `codexx revert` restores from this snapshot.

### 4.8 Backup directory

Path: `~/.config/claudex-cli/codex-backups/<ISO 8601>/`

```
<timestamp>/
  config.toml
  auth.json
  reason.txt           # "switch to openrouter", "user requested", etc.
  hashes.json
```

Retention: most recent 5 backups OR most recent 7 days, whichever covers more entries. Pruned at every `use`.

### 4.9 Audit log

Path: `~/.config/claudex-cli/codex-audit.log`

JSONL, append-only. One event per line.

```typescript
interface AuditEvent {
  ts: string;                               // ISO 8601
  action:
    | "use"
    | "add"
    | "remove"
    | "revert"
    | "restore"
    | "snapshot"
    | "drift_detected"
    | "chatgpt_backed_up"
    | "native_on"
    | "native_off";
  actor: string;                            // "codexx <version>"
  // action-specific fields below
}
```

## 5. Algorithms

### 5.1 Surgical TOML edit

Goal: insert / update / remove `[model_providers.claudex-X]` sections and top-level `model`/`model_provider` keys, preserving all other bytes verbatim.

```
function applyClaudexProvider(rawTOML, provider):
  parseTOML(rawTOML)                          # smol-toml.parse as guard; throws if invalid

  sections = findAllSectionHeaders(rawTOML)
  existing = sections.find(s => s.header == f"[model_providers.claudex-{provider.name}]")

  if existing:
    # Update path: replace BEGIN..END block in place
    next = replaceClaudexBlock(rawTOML, existing, buildBlock(provider))
  else:
    # Insert path: append after last [model_providers.*] section
    lastMP = sections.filter(s => s.header.startsWith("[model_providers.")).last()
    anchor = lastMP ? lastMP.endLine + 1 : EOF
    next = insertAt(rawTOML, anchor, buildBlock(provider))

  # Replace top-level keys via line-anchored regex
  next = next.replace(/^model = ".*"/m, f'model = "{provider.model}"')
  next = next.replace(/^model_provider = ".*"/m, f'model_provider = "claudex-{provider.name}"')

  # Post-validate
  parseTOML(next)
  assert verifyNonClaudexUntouched(rawTOML, next)
  return { next, diff }
```

`buildBlock(provider)`:

```
# claudex-cli managed BEGIN — provider=<name> schema=v1 ts=<now>
[model_providers.claudex-<name>]
name = "<name>"
base_url = "<base_url>"
wire_api = "<wire_api>"
requires_openai_auth = true
env_key = "OPENAI_API_KEY"
<optionally model_reasoning_effort = "...">
<optionally http_headers = {...}>
# claudex-cli managed END
```

`verifyNonClaudexUntouched(before, after)`:

- Parse both into TOML objects via smol-toml.
- Diff at section/key level.
- Allowed changes: top-level `model`, `model_provider`; anything under `[model_providers.claudex-*]`.
- Any other delta → reject the write.

### 5.2 Double-file atomic write with rollback

```
async function applyProviderSwitch(provider):
  lock = await acquireLock("~/.codex/.codexx-lock", timeout=5000)
  try:
    configBefore = await readFile("~/.codex/config.toml")
    authBefore = exists("~/.codex/auth.json") ? readFile(...) : null

    configNext = applyClaudexProvider(configBefore, provider).next
    authNext = buildAuthJsonForProvider(provider, authBefore)

    # Pre-validate without touching disk
    parseTOML(configNext)
    parseJSON(authNext)

    backupDir = await takeBackup({ reason: f"switch to {provider.name}" })

    # Write auth.json first (smaller, simpler rollback)
    await writeAtomic("~/.codex/auth.json", authNext, mode=0o600)

    try:
      await writeAtomic("~/.codex/config.toml", configNext)
    catch e:
      # Roll back auth.json
      if authBefore: await writeAtomic("~/.codex/auth.json", authBefore, mode=0o600)
      else: await fs.unlink("~/.codex/auth.json")
      throw e

    # Post-verify
    actualConfig = await readFile("~/.codex/config.toml")
    assert verifyNonClaudexUntouched(configBefore, actualConfig)

    # Update last-known hashes + audit log
    await writeLastKnownHashes({ config_toml_hash: sha256(actualConfig), ... })
    await appendAuditEvent({ action: "use", from: prev, to: provider.name, ... })
  finally:
    await lock.release()
```

`writeAtomic`:

```
async function writeAtomic(path, content, options):
  tmpPath = path + f".codexx-tmp.{Date.now()}.{random()}"
  await fs.writeFile(tmpPath, content, { mode: options.mode })
  fd = await fs.open(tmpPath)
  await fd.sync()                          # fsync
  await fd.close()
  await fs.rename(tmpPath, path)           # atomic on same FS
```

### 5.3 ChatGPT OAuth detection and backup

```
function detectChatGptAuth(auth):
  return (
    auth.auth_mode === "chatgpt" ||
    (auth.tokens && (auth.tokens.id_token || auth.tokens.access_token))
  )

async function backupChatGptTokensIfPresent(authBefore):
  if !authBefore or !detectChatGptAuth(authBefore): return null
  backupPath = "~/.config/claudex-cli/codex-backups/" + ts + "/chatgpt-tokens.json"
  await mkdirp(dirname(backupPath))
  await writeFile(backupPath, JSON.stringify(authBefore), { mode: 0o600 })
  await appendAuditEvent({ action: "chatgpt_backed_up", path: backupPath })
  return backupPath
```

### 5.4 Drift detection

```
async function detectDrift():
  lastKnown = await readLastKnownHashes()
  if !lastKnown: return { drifted: false }

  results = []
  configActual = sha256(await readFile("~/.codex/config.toml"))
  if configActual != lastKnown.config_toml_hash:
    results.push({ file: "config.toml", cause: analyzeConfigDrift(...) })
  if exists(authJsonPath):
    authActual = sha256(await readFile("~/.codex/auth.json"))
    if authActual != lastKnown.auth_json_hash:
      results.push({ file: "auth.json", cause: analyzeAuthDrift(...) })
  return { drifted: results.length > 0, files: results }
```

`analyzeConfigDrift`:

- If only the claudex-marked sections changed → `"claudex_section_modified"` (user edited our markers — unusual, prompt).
- If sections outside claudex changed → `"external_modification"` (codex mcp / plugin / login etc. — usually safe to proceed; reconcile).
- Otherwise → `"unknown"`.

### 5.5 Snapshot / revert

```
async function ensurePreClaudexSnapshot():
  dir = "~/.config/claudex-cli/codex-snapshot/pre-claudex"
  if exists(dir + "/manifest.json"): return       # idempotent

  await mkdirp(dir)
  for each f in [config.toml, auth.json, AGENTS.md]:
    if exists("~/.codex/" + f):
      await copyFile("~/.codex/" + f, dir + "/" + f)
      if f == "auth.json": await chmod(dir + "/" + f, 0o600)
  await writeFile(dir + "/manifest.json", JSON.stringify({
    ts: now(),
    codex_version: detectCodexVersion(),
    codexx_version: pkg.version,
    config_hash: sha256(...),
    auth_hash: sha256(...) or null,
  }))

async function revertToPreClaudex(opts):
  lock = await acquireLock(...)
  try:
    snapshot = readSnapshot()
    if !snapshot: throw "no pre-claudex snapshot found"
    if !opts.yes: confirm()

    await writeAtomic("~/.codex/config.toml", snapshot.config)
    if snapshot.auth:
      await writeAtomic("~/.codex/auth.json", snapshot.auth, mode=0o600)
    else:
      if exists("~/.codex/auth.json"): await fs.unlink("~/.codex/auth.json")
    if snapshot.AGENTS_md:
      await writeAtomic("~/.codex/AGENTS.md", snapshot.AGENTS_md)

    # Reset codexx own state (preserve audit log + backups by default)
    await fs.unlink("~/.config/claudex-cli/codex-current-provider")
    await fs.unlink("~/.config/claudex-cli/codex-last-known-hashes.json")
    if !opts.preserveBackups:
      await fs.rm("~/.config/claudex-cli/codex-backups", recursive=true)

    await appendAuditEvent({ action: "revert", restored_from: "pre-claudex" })
  finally:
    await lock.release()
```

### 5.6 Doctor check matrix

| Check | Logic | Status |
|---|---|---|
| codex CLI installed | `which codex` + `codex --version` | pass / fail |
| codex CLI version | parse semver; pass if >= 0.130, warn if < 0.130 | pass / warn |
| Codex Desktop App running | `pgrep -f Codex` on macOS, equivalent elsewhere | pass / warn (if running and recent switch) |
| Current active provider | read `codex-current-provider` | pass / warn (none) |
| config.toml hash drift | compare to `codex-last-known-hashes.json` | pass / fail |
| auth.json hash drift | same | pass / fail |
| ChatGPT OAuth detected | parse auth.json | info |
| Shell env `OPENAI_API_KEY` value matches active provider | env var vs current provider's key | pass / warn |
| Project-level `.codex/config.toml` override detected | walk from cwd up | pass / warn |
| Native context injection integrity | hash of AGENTS.md section vs `last_injected_hash` | pass / warn |
| Provider connectivity | optional HTTP probe | pass / fail |
| `cli_auth_credentials_store` setting | warn if `"keyring"` (not supported in MVP) | pass / warn |

## 6. Error Handling Matrix

| Scenario | Code | Behavior | User-facing message |
|---|---|---|---|
| codex not installed at `init` | 1 | Print install recommendation; exit | "Codex CLI not found. Install: <command>" |
| Provider name in RESERVED | 2 | Reject add | "Name 'openai' is reserved. Use a different name." |
| Invalid base_url | 2 | Reject add | "base_url must be http:// or https:// URL" |
| auth.json malformed | 1 | Refuse to write; suggest restore | "auth.json is malformed (line N). Try: codexx restore latest" |
| config.toml malformed | 1 | Refuse to write | Same shape |
| Disk full | 3 | Roll back completed writes; surface error | "Disk full while writing config.toml; rolled back auth.json" |
| Lock acquisition timeout | 5 | Print holder info if available | "Another codexx/codex process holds the lock. Wait or use --force." |
| Drift detected, no --force | 4 | Print drift summary | "Config drifted since last codexx write. Run: codexx reconcile" |
| ChatGPT OAuth, no --yes | 0 (after confirm) | Prompt before overwrite | "Detected ChatGPT login. Continue? [y/N]" |
| Markers missing in config.toml | 1 | Refuse to write | "Cannot find claudex markers in config.toml. Run: codexx repair" |
| Codex process running during use | 0 with warn | Write; print restart hint | "Codex CLI running (PID X). Restart to apply changes." |
| Snapshot dir missing on revert | 1 | Refuse | "No pre-claudex snapshot found. Cannot safely revert." |
| Network failure on test | 1 | Report HTTP status / error | "Test failed: connection refused" |
| Non-existent provider on use | 2 | List available providers | "Provider 'foo' not found. Available: [bar, baz]" |
| `cli_auth_credentials_store = "keyring"` | 1 | Refuse + instruction | "Keyring credential store not supported in MVP. Set to 'file' or 'auto'." |

## 7. Compatibility Matrix

| Component | Supported | MVP behavior | Future |
|---|---|---|---|
| codex CLI version | >= 0.120 | Works; below 0.130 → doctor recommends upgrade | Track upstream |
| Codex Desktop App | current | Works for backend routing; UI cosmetic upstream issues | — |
| Codex VS Code extension | current | Works for routing; new-session model bug upstream | — |
| macOS | >= 13 | First-class | — |
| Linux | Ubuntu 22.04+, Fedora 38+ | Best-effort; no keyring | First-class in v2 |
| Windows | 10 / 11 | Best-effort; no keyring | First-class in v2 |
| Node.js | >= 18 | First-class | — |
| `cli_auth_credentials_store = "keyring"` | Not supported MVP | doctor warns; user must use `"file"` or `"auto"` | Keyring backend in v2 |
| `requires_openai_auth = false` providers | Not supported MVP | doctor warns | `.env`-based path in v2 |
| Project-level `.codex/config.toml` | Best-effort | doctor detects override | Per-project profiles in v2 |
| Concurrent multi-shell on same host | Lock-based | Safe via proper-lockfile | — |
| Multi-host state sync | Not supported | — | Not planned |

## 8. Acceptance Criteria

Every milestone has verifiable, testable outcomes.

### M1: Shared layer extraction (PR 1)

- All 9 native-* modules moved to `src/shared/`.
- `src/cli.js` imports updated.
- Existing claudex test suite is 100% green; no public behavior change.

### M2: Core writers (PR 2)

- `config-toml.js` unit tests: 30+ cases pass.
- On every fixture in `tests/codex/fixtures/`: `use A → use B → use A → revert` leaves non-claudex bytes byte-identical.
- `auth-json.js`: chmod 600 verified by `stat`.
- ChatGPT detection: 3 OAuth fixture variants correctly identified.
- Atomic double-write: kill -9 mid-write leaves either before-state or after-state, never partial (validated via stress test).

### M3: CLI surface (PR 3)

- All claudex-owned subcommands implemented per §3.2.
- Passthrough verified for: `resume`, `exec`, `review`, `apply`, `fork`, `mcp`, `plugin`, `features`, `app`.
- `codexx --resume`: cross-provider session picker lists current directory's sessions across ALL providers (codex's `resume` only shows active provider's). Non-interactive: list-only; interactive: select by number → `codex resume <id>` with current provider. Excludes non-interactive (exec/review) sessions by default, matching codex picker behavior.
- `codexx --help` outputs all commands with one-line descriptions.
- `codexx -- update` reaches codex (not claudex self-update).
- Exit codes match §3.3 for each documented error case.

### M4: Diagnostics and rollback (PR 4)

- `codexx doctor` runs all checks listed in §5.6; output is parseable.
- `codexx revert` restores pre-claudex snapshot byte-for-byte from any state.
- `codexx restore <id>` works for any backup in retention window.
- `codexx audit --tail 10` produces JSONL valid against schema.

### M5: Native, menu, wrappers (PR 5)

- `codexx native on/off` injection cycle: 5 round-trips on user's real AGENTS.md leaves non-native sections byte-identical.
- `codexx menu` reaches feature parity with `claudex menu` (8 main items).
- `codexx login` warns before overwriting ChatGPT tokens; backup recoverable via `codexx restore-chatgpt`.

### M6: Release (PR 6)

- `npm run benchmark:native:all` includes codex dimension.
- README updated with codexx section.
- `docs/codexx-spec.md` finalized (this document).
- Smoke test on macOS 13/14/15 and Linux Ubuntu 22.04.
- Manual spike: switch providers, verify Desktop App routes correctly via network observation.

## 9. Resolved Decisions

All Open Questions from the original draft have been resolved during M1–M6 implementation:

| # | Question | Resolution |
|---|---|---|
| Q1 | Default `wire_api`: `chat` or `responses`? | `chat` (implemented as default in `cmdAdd` wizard and flag mode). |
| Q2 | `codexx use` auto-prompt to restart running codex/App? | Only print hint; codex >= v0.130 hot-reloads automatically, doctor reflects this. |
| Q3 | AGENTS.md injection: when to auto-prompt? | Only on explicit `codexx native on`; never auto-injected. |
| Q4 | `codexx update` semantics? | Self-update; `codexx -- update` passes through to `codex update`. |
| Q5 | Shell alias prompt in `codexx init`? | No prompt today; users keep typing `codexx`. Optional `npm link` for development. |
| Q6 | Backup retention defaults | 5 backups OR 7 days, whichever covers more entries. |
| Q7 | Encrypted backups in MVP? | No — chmod 600 only. Deferred to v2 alongside keyring. |
| Q8 | Keyring backend in MVP? | No — file-based `auth.json` + `.env`. Deferred to v2. |
| Q9 | Linux/Windows first-class in MVP? | Best-effort; macOS verified end-to-end. |
| Q10 | `codexx test` on missing/unsupported model? | Reports HTTP status + response body in failure reason; user decides. |

## 10. Out of Scope and Future

### v2 candidates

- Keyring backend (macOS Keychain / Windows Credential Manager / libsecret).
- Encrypted backup files (key in keyring).
- `requires_openai_auth = false` providers via `~/.codex/.env` injection path.
- Per-project codexx profiles (read `.codex/config.toml` project-level).
- Command-backed bearer auth (per PR #16288) for short-lived tokens.
- Local proxy gateway (cc-switch style: routing rewrites, failover).
- Codex Cloud / remote app-server compat.
- Multi-host state sync (Dropbox / iCloud style).

### Never

- Modifying Codex's own auth handler / source.
- Bypassing OpenAI ToS protections.
- Storing keys in cleartext in any synced/cloud location.
- Whole-file overwrite of `~/.codex/config.toml`.

## 11. References

### External

- [Codex Authentication](https://developers.openai.com/codex/auth)
- [Codex Configuration Reference](https://developers.openai.com/codex/config-reference)
- [Codex Advanced Configuration](https://developers.openai.com/codex/config-advanced)
- [PR #16288 — dynamic auth tokens for model providers](https://github.com/openai/codex/pull/16288)
- [Issue #19694 — Desktop model picker filtering for custom providers](https://github.com/openai/codex/issues/19694)
- [Issue #15364 — Custom provider support in App](https://github.com/openai/codex/issues/15364)
- [Issue #10867 — Custom model provider support](https://github.com/openai/codex/issues/10867)
- [Issue #4558 — VS Code extension with custom provider](https://github.com/openai/codex/issues/4558)
- [Issue #3860 — Hot reload proposal](https://github.com/openai/codex/issues/3860)
- [cc-switch source (Tauri/Rust reference)](https://github.com/farion1231/cc-switch)
- [cc-switch-cli (Rust CLI fork)](https://github.com/SaladDay/cc-switch-cli)

### Internal

- `docs/product-plan.md`
- `docs/native-roadmap.md`
- `src/cli.js` (claudex existing dispatch pattern)
- `tests/native-benchmarks/` (existing benchmark harness to extend)
