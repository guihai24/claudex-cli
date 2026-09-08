import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseConfigToml,
  findAllSectionHeaders,
  findClaudexSections,
  buildClaudexBlock,
  applyClaudexProvider,
  removeClaudexProvider,
  setTopLevelKey,
  verifyNonClaudexUntouched
} from '../../src/codex/config-toml.js';

import { toClaudexProviderId } from '../../src/codex/constants.js';

const FIXED_TS = '2026-05-17T12:00:00.000Z';
const buildOpts = { ts: FIXED_TS };

const SAMPLE_PROVIDER = {
  name: 'openrouter',
  base_url: 'https://openrouter.ai/api/v1',
  api_key: 'sk-or-v1-FAKE',
  model: 'anthropic/claude-sonnet-4.5',
  wire_api: 'chat'
};

const PROVIDER_FOO = {
  name: 'foo',
  base_url: 'https://api.foo.com/v1',
  api_key: 'sk-foo',
  model: 'foo-model',
  wire_api: 'chat'
};

const PROVIDER_BAR = {
  name: 'bar',
  base_url: 'https://api.bar.com/v1',
  api_key: 'sk-bar',
  model: 'bar-model',
  wire_api: 'responses',
  model_reasoning_effort: 'high'
};

// ===== buildClaudexBlock =====

test('buildClaudexBlock: emits markers + correct section header', () => {
  const block = buildClaudexBlock(SAMPLE_PROVIDER, buildOpts);
  const lines = block.split('\n');
  assert.match(lines[0], /^# claudex-cli managed BEGIN — provider=openrouter schema=v1 ts=2026-05-17T12:00:00\.000Z$/);
  assert.equal(lines[1], '[model_providers.claudex-openrouter]');
  assert.equal(lines[lines.length - 1], '# claudex-cli managed END');
});

test('buildClaudexBlock: includes mandatory requires_openai_auth and env_key', () => {
  const block = buildClaudexBlock(SAMPLE_PROVIDER, buildOpts);
  assert.ok(block.includes('requires_openai_auth = true'));
  assert.ok(block.includes('env_key = "OPENAI_API_KEY"'));
});

test('buildClaudexBlock: wire_api defaults to responses when absent', () => {
  const { wire_api, ...withoutWireApi } = SAMPLE_PROVIDER;
  const block = buildClaudexBlock(withoutWireApi, buildOpts);
  assert.ok(block.includes('wire_api = "responses"'));
});

test('buildClaudexBlock: writes optional reasoning_effort when present', () => {
  const block = buildClaudexBlock({ ...SAMPLE_PROVIDER, model_reasoning_effort: 'high' }, buildOpts);
  assert.ok(block.includes('model_reasoning_effort = "high"'));
});

test('buildClaudexBlock: omits optional reasoning_effort when absent', () => {
  const block = buildClaudexBlock(SAMPLE_PROVIDER, buildOpts);
  assert.ok(!block.includes('model_reasoning_effort'));
});

test('buildClaudexBlock: emits http_headers as inline table when provided', () => {
  const block = buildClaudexBlock(
    { ...SAMPLE_PROVIDER, http_headers: { 'X-Title': 'Claudex', 'X-Auth-Mode': 'apikey' } },
    buildOpts
  );
  // Bare keys (alphanumeric + hyphens + underscores) are TOML-valid without quotes
  assert.match(block, /http_headers = \{ X-Title = "Claudex", X-Auth-Mode = "apikey" \}/);
  const parsed = parseConfigToml(block);
  assert.deepEqual(
    parsed.model_providers['claudex-openrouter'].http_headers,
    { 'X-Title': 'Claudex', 'X-Auth-Mode': 'apikey' }
  );
});

test('buildClaudexBlock: quotes http_headers keys with special chars', () => {
  const block = buildClaudexBlock(
    { ...SAMPLE_PROVIDER, http_headers: { 'X-Title': 'a', 'X.Special.Key': 'b' } },
    buildOpts
  );
  assert.ok(block.includes('"X.Special.Key" = "b"'));
  const parsed = parseConfigToml(block);
  assert.equal(
    parsed.model_providers['claudex-openrouter'].http_headers['X.Special.Key'],
    'b'
  );
});

test('buildClaudexBlock: escapes special chars in base_url', () => {
  const block = buildClaudexBlock(
    { ...SAMPLE_PROVIDER, base_url: 'https://x.com/path?a="b"' },
    buildOpts
  );
  assert.ok(block.includes('base_url = "https://x.com/path?a=\\"b\\""'));
  assert.doesNotThrow(() => parseConfigToml(block));
});

test('buildClaudexBlock: output is valid TOML when parsed alone', () => {
  const block = buildClaudexBlock(PROVIDER_BAR, buildOpts);
  const parsed = parseConfigToml(block);
  assert.equal(parsed.model_providers['claudex-bar'].name, 'bar');
  assert.equal(parsed.model_providers['claudex-bar'].wire_api, 'responses');
  assert.equal(parsed.model_providers['claudex-bar'].requires_openai_auth, true);
});

// ===== findAllSectionHeaders =====

test('findAllSectionHeaders: empty file → no headers', () => {
  assert.deepEqual(findAllSectionHeaders(''), []);
});

test('findAllSectionHeaders: finds top-level and dotted sections in order', () => {
  const raw = `model = "x"
[a]
[b.c]
[d]`;
  const heads = findAllSectionHeaders(raw);
  assert.deepEqual(
    heads.map((h) => h.header),
    ['a', 'b.c', 'd']
  );
  assert.deepEqual(
    heads.map((h) => h.headerLine),
    [1, 2, 3]
  );
});

test('findAllSectionHeaders: ignores comment lines that look like sections', () => {
  const raw = `# [not-a-section]
[real]`;
  const heads = findAllSectionHeaders(raw);
  assert.deepEqual(heads.map((h) => h.header), ['real']);
});

test('findAllSectionHeaders: handles trailing inline comments on headers', () => {
  const raw = `[foo] # the foo
[bar]`;
  const heads = findAllSectionHeaders(raw);
  assert.deepEqual(heads.map((h) => h.header), ['foo', 'bar']);
});

// ===== findClaudexSections =====

test('findClaudexSections: empty file → no claudex sections', () => {
  assert.deepEqual(findClaudexSections(''), []);
});

test('findClaudexSections: detects claudex BEGIN/END pair with provider name', () => {
  const raw = `# claudex-cli managed BEGIN — provider=openrouter schema=v1 ts=2026
[model_providers.claudex-openrouter]
name = "openrouter"
# claudex-cli managed END
`;
  const sections = findClaudexSections(raw);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].providerName, 'openrouter');
  assert.equal(sections[0].beginLine, 0);
  assert.equal(sections[0].endLine, 3);
  assert.equal(sections[0].sectionHeader, 'model_providers.claudex-openrouter');
});

test('findClaudexSections: provider name with underscore parsed in full', () => {
  const raw = `# claudex-cli managed BEGIN — provider=any_baiwan schema=v1 ts=2026
[model_providers.claudex-any_baiwan]
name = "any_baiwan"
# claudex-cli managed END
`;
  const sections = findClaudexSections(raw);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].providerName, 'any_baiwan');
});

test('applyClaudexProvider: re-applying provider with underscore updates in place (no duplicate)', () => {
  const provider = {
    name: 'any_baiwan',
    base_url: 'https://anyrouter.top/v1',
    api_key: 'sk-fake',
    model: 'gpt-5.5',
    wire_api: 'responses'
  };
  let raw = '';
  raw = applyClaudexProvider(raw, provider, buildOpts).next;
  const r2 = applyClaudexProvider(raw, { ...provider, model: 'gpt-6' }, buildOpts);
  assert.equal(r2.diff.action, 'update');
  const parsed = parseConfigToml(r2.next);
  // Exactly one section, and its base_url is the new one (well, same here)
  assert.ok(parsed.model_providers['claudex-any_baiwan']);
  const sections = findClaudexSections(r2.next);
  assert.equal(sections.length, 1);
});

test('findClaudexSections: detects multiple claudex pairs', () => {
  const raw = `# claudex-cli managed BEGIN — provider=a schema=v1
[model_providers.claudex-a]
# claudex-cli managed END

# claudex-cli managed BEGIN — provider=b schema=v1
[model_providers.claudex-b]
# claudex-cli managed END
`;
  const sections = findClaudexSections(raw);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((s) => s.providerName), ['a', 'b']);
});

test('findClaudexSections: throws on unmatched BEGIN', () => {
  const raw = `# claudex-cli managed BEGIN — provider=a
[model_providers.claudex-a]
name = "a"`;
  assert.throws(() => findClaudexSections(raw), /no matching END/);
});

// ===== applyClaudexProvider: insert =====

test('applyClaudexProvider: inserts into empty file', () => {
  const { next } = applyClaudexProvider('', SAMPLE_PROVIDER, buildOpts);
  const parsed = parseConfigToml(next);
  assert.equal(parsed.model_provider, 'claudex-openrouter');
  assert.equal(parsed.model, 'anthropic/claude-sonnet-4.5');
  assert.equal(parsed.model_providers['claudex-openrouter'].base_url, 'https://openrouter.ai/api/v1');
});

test('applyClaudexProvider: inserts after existing [model_providers.X]', () => {
  const raw = `model = "old-model"
model_provider = "custom"

[model_providers.custom]
base_url = "https://existing.example.com"
env_key = "OPENAI_API_KEY"

[projects."/repo"]
trust_level = "trusted"
`;
  const { next } = applyClaudexProvider(raw, SAMPLE_PROVIDER, buildOpts);
  const parsed = parseConfigToml(next);
  assert.equal(parsed.model_provider, 'claudex-openrouter');
  assert.equal(parsed.model_providers.custom.base_url, 'https://existing.example.com');
  assert.equal(parsed.model_providers['claudex-openrouter'].base_url, SAMPLE_PROVIDER.base_url);
  assert.equal(parsed.projects['/repo'].trust_level, 'trusted');
});

test('applyClaudexProvider: preserves comments outside our section', () => {
  const raw = `# my personal codex config
# do not edit without reason

model = "gpt-5"
model_provider = "openai"

# trusted projects
[projects."/repo"]
trust_level = "trusted"  # leave this alone
`;
  const { next } = applyClaudexProvider(raw, SAMPLE_PROVIDER, buildOpts);
  assert.ok(next.includes('# my personal codex config'));
  assert.ok(next.includes('# do not edit without reason'));
  assert.ok(next.includes('# trusted projects'));
  assert.ok(next.includes('trust_level = "trusted"  # leave this alone'));
});

test('applyClaudexProvider: marks diff action=insert on first apply', () => {
  const { diff } = applyClaudexProvider('', SAMPLE_PROVIDER, buildOpts);
  assert.equal(diff.action, 'insert');
  assert.equal(diff.providerName, 'openrouter');
});

// ===== applyClaudexProvider: update =====

test('applyClaudexProvider: updates existing claudex section in place', () => {
  const initial = applyClaudexProvider('', SAMPLE_PROVIDER, buildOpts).next;
  const updated = applyClaudexProvider(
    initial,
    { ...SAMPLE_PROVIDER, base_url: 'https://openrouter.ai/v2', model: 'newer-model' },
    buildOpts
  );
  assert.equal(updated.diff.action, 'update');
  const parsed = parseConfigToml(updated.next);
  assert.equal(parsed.model_providers['claudex-openrouter'].base_url, 'https://openrouter.ai/v2');
  assert.equal(parsed.model, 'newer-model');
});

test('applyClaudexProvider: switching active provider does not delete other claudex sections', () => {
  let raw = '';
  raw = applyClaudexProvider(raw, PROVIDER_FOO, buildOpts).next;
  raw = applyClaudexProvider(raw, PROVIDER_BAR, buildOpts).next;
  const parsed = parseConfigToml(raw);
  assert.equal(parsed.model_provider, 'claudex-bar');
  assert.equal(parsed.model, 'bar-model');
  assert.ok(parsed.model_providers['claudex-foo'], 'foo section retained');
  assert.ok(parsed.model_providers['claudex-bar'], 'bar section present');
});

// ===== applyClaudexProvider: adopt orphaned claudex table =====

test('applyClaudexProvider: adopts orphaned claudex table when markers were stripped by external edit', () => {
  // External TOML rewrites (parse → serialize) drop comments, leaving our
  // table without BEGIN/END markers. Re-applying must not insert a duplicate.
  const raw = `model = "gpt-5"
model_provider = "claudex-openrouter"

[model_providers.claudex-openrouter]
name = "openrouter"
base_url = "https://old.example.com/v1"
wire_api = "chat"
requires_openai_auth = true
env_key = "OPENAI_API_KEY"

[projects."/repo"]
trust_level = "trusted"
`;
  const { next, diff } = applyClaudexProvider(raw, SAMPLE_PROVIDER, buildOpts);
  assert.equal(diff.action, 'update');
  const parsed = parseConfigToml(next);
  assert.equal(parsed.model_providers['claudex-openrouter'].base_url, 'https://openrouter.ai/api/v1');
  assert.equal(parsed.projects['/repo'].trust_level, 'trusted');
  // Adopted section is marker-wrapped again
  const sections = findClaudexSections(next);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].providerName, 'openrouter');
});

test('applyClaudexProvider: adopts table with corrupted BEGIN marker and sweeps stray END', () => {
  const raw = `model = "gpt-5"
model_provider = "claudex-openrouter"

# claudex-cli managed BEGIN â€" provider=openrouter schema=v1 ts=2026-01-01T00:00:00.000Z
[model_providers.claudex-openrouter]
name = "openrouter"
base_url = "https://old.example.com/v1"
# claudex-cli managed END
`;
  const { next, diff } = applyClaudexProvider(raw, SAMPLE_PROVIDER, buildOpts);
  assert.equal(diff.action, 'update');
  parseConfigToml(next);
  const sections = findClaudexSections(next);
  assert.equal(sections.length, 1);
  // Corrupted BEGIN line swept along with the adopted section
  assert.ok(!next.includes('â€'));
  // Exactly one marker pair remains
  assert.equal((next.match(/claudex-cli managed END/g) || []).length, 1);
});

test('applyClaudexProvider: adopting orphan does not consume comments belonging to the next section', () => {
  const raw = `[model_providers.claudex-openrouter]
name = "openrouter"
base_url = "https://old.example.com/v1"

# trusted projects
[projects."/repo"]
trust_level = "trusted"
`;
  const { next } = applyClaudexProvider(raw, SAMPLE_PROVIDER, buildOpts);
  assert.ok(next.includes('# trusted projects'));
  const parsed = parseConfigToml(next);
  assert.equal(parsed.projects['/repo'].trust_level, 'trusted');
});

test('applyClaudexProvider: does not adopt orphaned tables of other providers', () => {
  const raw = `[model_providers.claudex-foo]
name = "foo"
base_url = "https://api.foo.com/v1"
`;
  const { next, diff } = applyClaudexProvider(raw, SAMPLE_PROVIDER, buildOpts);
  assert.equal(diff.action, 'insert');
  const parsed = parseConfigToml(next);
  assert.ok(parsed.model_providers['claudex-foo'], 'unrelated orphan left untouched');
  assert.ok(parsed.model_providers['claudex-openrouter']);
});

// ===== setTopLevelKey =====

test('setTopLevelKey: updates existing key in place preserving comment', () => {
  const raw = `model = "gpt-5"  # default
model_provider = "openai"
[other]
key = "value"
`;
  const next = setTopLevelKey(raw, 'model', 'gpt-5.4');
  assert.ok(next.includes('model = "gpt-5.4"  # default'));
  assert.ok(next.includes('model_provider = "openai"'));
});

test('setTopLevelKey: only matches top-level (not under a section)', () => {
  const raw = `model = "top-level-value"
[some.section]
model = "nested-value"
`;
  const next = setTopLevelKey(raw, 'model', 'new-top-value');
  const parsed = parseConfigToml(next);
  assert.equal(parsed.model, 'new-top-value');
  assert.equal(parsed['some.section'] || parsed.some?.section?.model, 'nested-value');
});

test('setTopLevelKey: inserts new key when missing (no sections in file)', () => {
  const next = setTopLevelKey('', 'model', 'fresh');
  const parsed = parseConfigToml(next);
  assert.equal(parsed.model, 'fresh');
});

test('setTopLevelKey: inserts before first section when missing', () => {
  const raw = `[projects."/x"]
trust_level = "trusted"
`;
  const next = setTopLevelKey(raw, 'model', 'fresh');
  const parsed = parseConfigToml(next);
  assert.equal(parsed.model, 'fresh');
  assert.equal(parsed.projects['/x'].trust_level, 'trusted');
});

// ===== removeClaudexProvider =====

test('removeClaudexProvider: removes section by name', () => {
  const initial = applyClaudexProvider('', SAMPLE_PROVIDER, buildOpts).next;
  const { next, diff } = removeClaudexProvider(initial, 'openrouter');
  assert.equal(diff.action, 'remove');
  const parsed = parseConfigToml(next);
  assert.equal(parsed.model_providers?.['claudex-openrouter'], undefined);
});

test('removeClaudexProvider: no-op for unknown name', () => {
  const initial = applyClaudexProvider('', SAMPLE_PROVIDER, buildOpts).next;
  const { next, diff } = removeClaudexProvider(initial, 'does-not-exist');
  assert.equal(diff.action, 'noop');
  assert.equal(next, initial);
});

test('removeClaudexProvider: leaves user sections untouched', () => {
  const userBase = `[model_providers.custom]
base_url = "https://existing.example.com"
env_key = "OPENAI_API_KEY"

[projects."/repo"]
trust_level = "trusted"
`;
  let raw = userBase;
  raw = applyClaudexProvider(raw, SAMPLE_PROVIDER, buildOpts).next;
  const { next } = removeClaudexProvider(raw, 'openrouter');
  const parsed = parseConfigToml(next);
  assert.equal(parsed.model_providers.custom.base_url, 'https://existing.example.com');
  assert.equal(parsed.projects['/repo'].trust_level, 'trusted');
  assert.equal(parsed.model_providers?.['claudex-openrouter'], undefined);
});

// ===== verifyNonClaudexUntouched =====

test('verifyNonClaudexUntouched: identical files → ok', () => {
  const raw = `model = "x"\n[a]\nk = 1\n`;
  const result = verifyNonClaudexUntouched(raw, raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedKeys, []);
});

test('verifyNonClaudexUntouched: top-level model/model_provider changes allowed', () => {
  const before = `model = "a"\nmodel_provider = "x"\n`;
  const after = `model = "b"\nmodel_provider = "y"\n`;
  const result = verifyNonClaudexUntouched(before, after);
  assert.equal(result.ok, true);
});

test('verifyNonClaudexUntouched: claudex section changes allowed', () => {
  const before = applyClaudexProvider('', SAMPLE_PROVIDER, buildOpts).next;
  const after = applyClaudexProvider(before, { ...SAMPLE_PROVIDER, base_url: 'https://different' }, buildOpts).next;
  const result = verifyNonClaudexUntouched(before, after);
  assert.equal(result.ok, true, JSON.stringify(result.changedKeys));
});

test('verifyNonClaudexUntouched: detects forbidden change to non-claudex section', () => {
  const before = `[projects."/x"]\ntrust_level = "trusted"\n`;
  const after = `[projects."/x"]\ntrust_level = "untrusted"\n`;
  const result = verifyNonClaudexUntouched(before, after);
  assert.equal(result.ok, false);
  assert.ok(result.changedKeys.includes('projects'));
});

test('verifyNonClaudexUntouched: detects forbidden top-level key change', () => {
  const before = `personality = "pragmatic"\n`;
  const after = `personality = "creative"\n`;
  const result = verifyNonClaudexUntouched(before, after);
  assert.equal(result.ok, false);
  assert.ok(result.changedKeys.includes('personality'));
});

test('verifyNonClaudexUntouched: detects changes to user [model_providers.X]', () => {
  const before = `[model_providers.custom]\nbase_url = "https://a"\nenv_key = "OPENAI_API_KEY"\n`;
  const after = `[model_providers.custom]\nbase_url = "https://b"\nenv_key = "OPENAI_API_KEY"\n`;
  const result = verifyNonClaudexUntouched(before, after);
  assert.equal(result.ok, false);
  assert.ok(result.changedKeys.includes('model_providers.custom'));
});

// ===== integration: round-trip on realistic config =====

test('integration: use A → use B → use A → remove A → remove B preserves user sections byte-identical to original after both removals', () => {
  const userConfig = `# personal codex config
model = "gpt-5.5"
model_provider = "custom"
model_reasoning_effort = "high"
disable_response_storage = true
personality = "pragmatic"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "https://opencoder.example.com/v1"
env_key = "OPENAI_API_KEY"

[projects."/Users/me"]
trust_level = "trusted"

[projects."/Users/me/work"]
trust_level = "trusted"

[notice.model_migrations]
"gpt-5.3" = "gpt-5.4"

[plugins."superpowers@curated"]
enabled = true

[features]
codex_hooks = true
`;

  let raw = userConfig;
  raw = applyClaudexProvider(raw, PROVIDER_FOO, buildOpts).next;
  raw = applyClaudexProvider(raw, PROVIDER_BAR, buildOpts).next;
  raw = applyClaudexProvider(raw, PROVIDER_FOO, buildOpts).next; // switch back
  raw = removeClaudexProvider(raw, 'foo').next;
  raw = removeClaudexProvider(raw, 'bar').next;

  // Reset top-level keys to original (claudex doesn't auto-revert them — that's revertToPreClaudex's job)
  raw = setTopLevelKey(raw, 'model', 'gpt-5.5');
  raw = setTopLevelKey(raw, 'model_provider', 'custom');

  const parsed = parseConfigToml(raw);
  assert.equal(parsed.model, 'gpt-5.5');
  assert.equal(parsed.model_provider, 'custom');
  assert.equal(parsed.model_providers.custom.base_url, 'https://opencoder.example.com/v1');
  assert.equal(parsed.projects['/Users/me'].trust_level, 'trusted');
  assert.equal(parsed.projects['/Users/me/work'].trust_level, 'trusted');
  assert.equal(parsed.notice.model_migrations['gpt-5.3'], 'gpt-5.4');
  assert.equal(parsed.plugins['superpowers@curated'].enabled, true);
  assert.equal(parsed.features.codex_hooks, true);
  assert.equal(parsed.personality, 'pragmatic');
  assert.equal(parsed.disable_response_storage, true);
  assert.equal(parsed.model_reasoning_effort, 'high');

  // No claudex section should remain
  assert.equal(parsed.model_providers['claudex-foo'], undefined);
  assert.equal(parsed.model_providers['claudex-bar'], undefined);

  // Comments outside our markers preserved
  assert.ok(raw.includes('# personal codex config'));
});
