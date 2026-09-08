import { parse as parseTomlStrict } from 'smol-toml';

import {
  CONFIG_TOML_MARKER_END,
  CLAUDEX_PROVIDER_PREFIX,
  SCHEMA_VERSION,
  toClaudexProviderId
} from './constants.js';

const MARKER_BEGIN_PATTERN = /^#\s*claudex-cli managed BEGIN(?:\s*[—-]\s*(.*))?$/;
const MARKER_END_PATTERN = /^#\s*claudex-cli managed END\s*$/;
const PROVIDER_FIELD_PATTERN = /provider=([a-z0-9][a-z0-9_-]*)/;
const SECTION_HEADER_PATTERN = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;

/**
 * Parse raw TOML for validation. Throws on syntax error.
 * Returns the parsed object (we generally don't use the object for writes
 * — we use string surgery; this is just a guard).
 */
export function parseConfigToml(raw) {
  return parseTomlStrict(raw);
}

/**
 * Find every section header line in the file.
 * Returns [{ header, headerLine }] (line index 0-based).
 * Lines starting with # or inside multi-line strings are ignored.
 * TOML multi-line strings are NOT supported here — we assume claudex
 * config.toml does not embed `[...]` inside multi-line strings.
 * This is consistent with the surgical-edit invariant: we only operate on
 * configs whose structure we can recognise line-by-line.
 */
export function findAllSectionHeaders(raw) {
  const lines = splitLines(raw);
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('#')) continue;
    const m = lines[i].match(SECTION_HEADER_PATTERN);
    if (m) headers.push({ header: m[1].trim(), headerLine: i });
  }
  return headers;
}

/**
 * Locate every claudex-managed section by its BEGIN/END markers.
 * Returns [{ providerName, beginLine, endLine, sectionHeader, sectionHeaderLine }].
 * Throws if a BEGIN has no matching END within the file.
 */
export function findClaudexSections(raw) {
  const lines = splitLines(raw);
  const sections = [];
  let i = 0;
  while (i < lines.length) {
    const beginMatch = lines[i].match(MARKER_BEGIN_PATTERN);
    if (!beginMatch) {
      i++;
      continue;
    }
    const metadata = beginMatch[1] || '';
    const providerMatch = metadata.match(PROVIDER_FIELD_PATTERN);
    const providerName = providerMatch ? providerMatch[1] : null;
    const beginLine = i;
    let endLine = -1;
    let sectionHeader = null;
    let sectionHeaderLine = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (MARKER_END_PATTERN.test(lines[j])) {
        endLine = j;
        break;
      }
      const sh = lines[j].match(SECTION_HEADER_PATTERN);
      if (sh && sectionHeader === null) {
        sectionHeader = sh[1].trim();
        sectionHeaderLine = j;
      }
    }
    if (endLine === -1) {
      throw new Error(
        `claudex marker BEGIN at line ${beginLine + 1} has no matching END`
      );
    }
    sections.push({ providerName, beginLine, endLine, sectionHeader, sectionHeaderLine });
    i = endLine + 1;
  }
  return sections;
}

/**
 * Build a marker-delimited section block (no trailing newline) for a provider.
 * @param {object} provider — codexx provider metadata
 * @param {object} [opts] — { ts?: Date | string }
 */
export function buildClaudexBlock(provider, opts = {}) {
  const ts =
    typeof opts.ts === 'string'
      ? opts.ts
      : (opts.ts instanceof Date ? opts.ts : new Date()).toISOString();
  const wireApi = provider.wire_api || 'responses';
  const beginLine = `# claudex-cli managed BEGIN — provider=${provider.name} schema=v${SCHEMA_VERSION} ts=${ts}`;
  const lines = [
    beginLine,
    `[model_providers.${toClaudexProviderId(provider.name)}]`,
    `name = "${escapeTomlString(provider.name)}"`,
    `base_url = "${escapeTomlString(provider.base_url)}"`,
    `wire_api = "${escapeTomlString(wireApi)}"`,
    `requires_openai_auth = true`,
    `env_key = "OPENAI_API_KEY"`
  ];
  if (provider.model_reasoning_effort) {
    lines.push(`model_reasoning_effort = "${escapeTomlString(provider.model_reasoning_effort)}"`);
  }
  if (provider.disable_response_storage !== undefined) {
    lines.push(`disable_response_storage = ${provider.disable_response_storage ? 'true' : 'false'}`);
  }
  if (provider.http_headers && Object.keys(provider.http_headers).length > 0) {
    const pairs = Object.entries(provider.http_headers).map(
      ([k, v]) => `${quoteTomlKey(k)} = "${escapeTomlString(v)}"`
    );
    lines.push(`http_headers = { ${pairs.join(', ')} }`);
  }
  lines.push(CONFIG_TOML_MARKER_END);
  return lines.join('\n');
}

/**
 * Insert or replace the claudex-managed section for a provider and set
 * top-level `model` and `model_provider` to point at it.
 * @returns { next: string, diff: { action: 'insert'|'update', providerName: string, topLevelChanges: object } }
 */
export function applyClaudexProvider(raw, provider, opts = {}) {
  parseConfigToml(raw); // guard
  const block = buildClaudexBlock(provider, opts);

  // Set top-level keys FIRST, while no claudex section is in the file yet.
  // This avoids `setTopLevelKeyResult` placing them inside our marker block
  // when it scans for the "first section header" boundary.
  const topLevelChanges = {};
  const claudexId = toClaudexProviderId(provider.name);
  let next = setTopLevelKeyResult(raw, 'model_provider', claudexId, topLevelChanges);
  if (provider.model) {
    next = setTopLevelKeyResult(next, 'model', provider.model, topLevelChanges);
  }

  // Then insert or replace the claudex section.
  const existing = findClaudexSections(next).find(
    (s) => s.providerName === provider.name
  );
  let action;
  if (existing) {
    next = replaceLineRange(next, existing.beginLine, existing.endLine, block);
    action = 'update';
  } else {
    // Markers may have been stripped/corrupted by an external edit while the
    // table itself survived — inserting blindly would redefine the table and
    // fail TOML validation. Adopt the orphaned section instead.
    const orphan = findOrphanClaudexSection(next, claudexId);
    if (orphan) {
      next = replaceLineRange(next, orphan.fromLine, orphan.toLine, block);
      action = 'update';
    } else {
      next = insertAtAnchor(next, block);
      action = 'insert';
    }
  }

  parseConfigToml(next); // post-validate parses
  return {
    next,
    diff: { action, providerName: provider.name, topLevelChanges }
  };
}

/**
 * Remove a claudex-managed provider section if present.
 * Does NOT change top-level keys — the caller must update them separately
 * (e.g. to switch to another provider or to fall back to a built-in).
 */
export function removeClaudexProvider(raw, providerName) {
  parseConfigToml(raw);
  const sections = findClaudexSections(raw);
  const target = sections.find((s) => s.providerName === providerName);
  if (!target) return { next: raw, diff: { action: 'noop', providerName } };
  const next = deleteLineRange(raw, target.beginLine, target.endLine);
  parseConfigToml(next);
  return { next, diff: { action: 'remove', providerName } };
}

/**
 * Set or update a top-level key. Preserves trailing comments and surrounding lines.
 * If the key already exists at the top level (before any section header), update it.
 * Otherwise insert it in the preamble (before any section).
 */
export function setTopLevelKey(raw, key, value) {
  return setTopLevelKeyResult(raw, key, value, {});
}

function setTopLevelKeyResult(raw, key, value, changes) {
  const lines = splitLines(raw);
  const firstSectionLine = findFirstSectionLine(lines);
  const keyLineIndex = findTopLevelKeyLine(lines, key, firstSectionLine);
  const newKv = `${key} = "${escapeTomlString(value)}"`;
  if (keyLineIndex !== -1) {
    const before = lines[keyLineIndex];
    const next = replaceKeyValueLine(before, key, value);
    if (next === before) return raw;
    lines[keyLineIndex] = next;
    changes[key] = { previous: extractStringValue(before, key), next: value };
    return joinLines(lines, raw);
  }
  const insertAt = firstSectionLine === -1 ? lines.length : firstSectionLine;
  let prefix = '';
  if (insertAt > 0 && lines[insertAt - 1].trim() !== '') prefix = '';
  lines.splice(insertAt, 0, newKv);
  if (insertAt > 0 && lines[insertAt - 1].trim() !== '' && firstSectionLine !== -1) {
    // ensure a blank line between preamble keys and the first section
    if (lines[insertAt + 1] && lines[insertAt + 1].trim() !== '') {
      lines.splice(insertAt + 1, 0, '');
    }
  }
  changes[key] = { previous: null, next: value };
  return joinLines(lines, raw);
}

/**
 * Verify that no TOML keys/sections outside the claudex namespace changed.
 * Allowed changes:
 *   - Top-level `model` and `model_provider`
 *   - Anything under [model_providers.claudex-*]
 * Returns { ok, changedKeys: string[] } where changedKeys lists offending paths.
 */
export function verifyNonClaudexUntouched(beforeRaw, afterRaw) {
  const before = parseConfigToml(beforeRaw);
  const after = parseConfigToml(afterRaw);
  const allowed = new Set(['model', 'model_provider']);
  const changedKeys = [];
  const allKeys = new Set([...allPathsTopLevel(before), ...allPathsTopLevel(after)]);
  for (const key of allKeys) {
    if (allowed.has(key)) continue;
    if (key === 'model_providers') {
      const mpBefore = (before.model_providers || {});
      const mpAfter = (after.model_providers || {});
      const subKeys = new Set([...Object.keys(mpBefore), ...Object.keys(mpAfter)]);
      for (const sub of subKeys) {
        if (sub.startsWith(CLAUDEX_PROVIDER_PREFIX)) continue;
        if (!deepEqual(mpBefore[sub], mpAfter[sub])) {
          changedKeys.push(`model_providers.${sub}`);
        }
      }
      continue;
    }
    if (!deepEqual(before[key], after[key])) {
      changedKeys.push(key);
    }
  }
  return { ok: changedKeys.length === 0, changedKeys };
}

// ===== internal helpers =====

function splitLines(raw) {
  if (raw === '') return [];
  return raw.split('\n');
}

function joinLines(lines, originalRaw) {
  const out = lines.join('\n');
  // Preserve trailing-newline state of the original raw input
  const originalEndsWithNewline = originalRaw.endsWith('\n');
  const outEndsWithNewline = out.endsWith('\n');
  if (originalEndsWithNewline && !outEndsWithNewline) return out + '\n';
  if (!originalEndsWithNewline && outEndsWithNewline) return out.replace(/\n$/, '');
  return out;
}

function replaceLineRange(raw, fromLineIdx, toLineIdx, replacement) {
  const lines = splitLines(raw);
  const replacementLines = replacement.split('\n');
  lines.splice(fromLineIdx, toLineIdx - fromLineIdx + 1, ...replacementLines);
  return joinLines(lines, raw);
}

function deleteLineRange(raw, fromLineIdx, toLineIdx) {
  const lines = splitLines(raw);
  // Also consume one trailing blank line if present (so removal looks clean)
  let removeCount = toLineIdx - fromLineIdx + 1;
  if (lines[toLineIdx + 1] !== undefined && lines[toLineIdx + 1].trim() === '') {
    removeCount += 1;
  } else if (fromLineIdx > 0 && lines[fromLineIdx - 1].trim() === '') {
    // alternatively consume one leading blank line if no trailing blank exists
    lines.splice(fromLineIdx - 1, 1);
    fromLineIdx -= 1;
  }
  lines.splice(fromLineIdx, removeCount);
  return joinLines(lines, raw);
}

/**
 * Find a claudex-owned table whose BEGIN/END markers were lost or corrupted
 * by an external edit (comment-dropping TOML rewrites, manual edits, encoding
 * damage to the em-dash in the BEGIN line). Since parseConfigToml(raw) has
 * already succeeded, the header appears at most once, so replacing the whole
 * section is safe. Returns { fromLine, toLine } (inclusive) or null.
 */
function findOrphanClaudexSection(raw, claudexId) {
  const target = `model_providers.${claudexId}`;
  const headers = findAllSectionHeaders(raw);
  const hit = headers.find((h) => h.header === target);
  if (!hit) return null;
  const lines = splitLines(raw);
  const nextHeader = headers.find((h) => h.headerLine > hit.headerLine);
  const boundary = nextHeader ? nextHeader.headerLine : lines.length;
  // Section body ends at its last key-value line; trailing blanks/comments may
  // belong to the next section, so they are not consumed by default.
  let toLine = hit.headerLine;
  for (let i = hit.headerLine + 1; i < boundary; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    toLine = i;
  }
  // Sweep a stray END marker directly after the body (blanks allowed); any
  // other comment stops the sweep — it may document the next section.
  for (let i = toLine + 1; i < boundary; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#') && trimmed.includes('claudex-cli managed END')) {
      toLine = i;
    }
    break;
  }
  // Sweep a corrupted BEGIN marker immediately above the header.
  let fromLine = hit.headerLine;
  if (fromLine > 0) {
    const above = lines[fromLine - 1].trim();
    if (above.startsWith('#') && above.includes('claudex-cli managed BEGIN')) {
      fromLine -= 1;
    }
  }
  return { fromLine, toLine };
}

/**
 * Find the anchor for inserting a new claudex section.
 * Strategy: append after the last [model_providers.*] section.
 * If none exists, append at end of file.
 * Always insert with a leading blank line for readability.
 */
function insertAtAnchor(raw, block) {
  const headers = findAllSectionHeaders(raw);
  const mpHeaders = headers.filter(
    (h) => h.header === 'model_providers' || h.header.startsWith('model_providers.')
  );
  const lines = splitLines(raw);
  let insertAfter;
  if (mpHeaders.length > 0) {
    const last = mpHeaders[mpHeaders.length - 1];
    insertAfter = findSectionEndLine(lines, last.headerLine, headers);
  } else {
    insertAfter = lines.length - 1;
  }
  const before = lines.slice(0, insertAfter + 1);
  const after = lines.slice(insertAfter + 1);
  // ensure exactly one blank line between previous content and new block
  while (before.length > 0 && before[before.length - 1].trim() === '') before.pop();
  const blockLines = block.split('\n');
  const merged = [...before, '', ...blockLines];
  if (after.length > 0) {
    if (after[0].trim() !== '') merged.push('');
    merged.push(...after);
  } else {
    // append trailing newline-ish — handled by joinLines
  }
  return joinLines(merged, raw);
}

function findSectionEndLine(lines, headerLine, allHeaders) {
  const next = allHeaders.find((h) => h.headerLine > headerLine);
  if (!next) return lines.length - 1;
  // end is the line just before next section header, excluding trailing blank lines
  let end = next.headerLine - 1;
  while (end > headerLine && lines[end].trim() === '') end--;
  return end;
}

function findFirstSectionLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('#')) continue;
    if (SECTION_HEADER_PATTERN.test(lines[i])) return i;
  }
  return -1;
}

function findTopLevelKeyLine(lines, key, firstSectionLine) {
  const limit = firstSectionLine === -1 ? lines.length : firstSectionLine;
  const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  for (let i = 0; i < limit; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('#')) continue;
    if (re.test(lines[i])) return i;
  }
  return -1;
}

function replaceKeyValueLine(line, key, value) {
  // Match `key = "..."` and replace just the string literal.
  // Preserves leading whitespace and trailing comments.
  const re = new RegExp(`^(\\s*${escapeRegex(key)}\\s*=\\s*)"[^"]*"(.*)$`);
  if (re.test(line)) {
    return line.replace(re, (_, p1, p2) => `${p1}"${escapeTomlString(value)}"${p2}`);
  }
  // If existing form is not a basic string (number/boolean/array/multi-line),
  // refuse to silently rewrite — preserve as-is and signal to caller via no-op.
  return line;
}

function extractStringValue(line, key) {
  const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*"([^"]*)"`);
  const m = line.match(re);
  return m ? m[1] : null;
}

function escapeTomlString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function quoteTomlKey(k) {
  if (/^[A-Za-z0-9_-]+$/.test(k)) return k;
  return `"${escapeTomlString(k)}"`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function allPathsTopLevel(obj) {
  if (obj === null || typeof obj !== 'object') return [];
  return Object.keys(obj);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}
