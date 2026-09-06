import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  exists,
  ensureDir,
  readJson,
  writeJson,
  readText,
  writeAtomic,
  sha256,
  sha256File,
  copyFileMode,
  expandTilde,
  isoStamp
} from '../../src/shared/fs-utils.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function mktemp(prefix = 'codexx-test-') {
  const dir = path.join(os.tmpdir(), prefix + crypto.randomBytes(8).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

test('exists: returns true for existing file, false otherwise', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'a.txt');
  await fsp.writeFile(file, 'hi');
  assert.equal(await exists(file), true);
  assert.equal(await exists(path.join(dir, 'nope.txt')), false);
});

test('ensureDir: creates nested directories idempotently', async () => {
  const dir = await mktemp();
  const nested = path.join(dir, 'a', 'b', 'c');
  await ensureDir(nested);
  await ensureDir(nested);
  const stat = await fsp.stat(nested);
  assert.equal(stat.isDirectory(), true);
});

test('writeAtomic: writes file and content matches', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'out.txt');
  await writeAtomic(file, 'hello atomic\n');
  const back = await fsp.readFile(file, 'utf8');
  assert.equal(back, 'hello atomic\n');
});

test('writeAtomic: leaves no temp files on success', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'out.txt');
  await writeAtomic(file, 'final');
  const entries = await fsp.readdir(dir);
  assert.deepEqual(entries, ['out.txt']);
});

test('writeAtomic: respects mode option', async () => {
  if (process.platform === 'win32') return;
  const dir = await mktemp();
  const file = path.join(dir, 'secret.txt');
  await writeAtomic(file, 'topsecret', { mode: 0o600 });
  const stat = await fsp.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('writeAtomic: replaces existing file content atomically', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'rotating.txt');
  await fsp.writeFile(file, 'old content');
  await writeAtomic(file, 'new content');
  assert.equal(await fsp.readFile(file, 'utf8'), 'new content');
});

test('writeAtomic: preserves the existing file mode when no mode option given', async () => {
  if (process.platform === 'win32') return;
  const dir = await mktemp();
  const file = path.join(dir, 'config.toml');
  await fsp.writeFile(file, 'model = "a"\n', { mode: 0o600 });
  await writeAtomic(file, 'model = "b"\n');
  const stat = await fsp.stat(file);
  assert.equal(stat.mode & 0o777, 0o600, 'rename() must not widen 0600 → 0644');
});

test('writeAtomic: explicit mode option wins over the existing file mode', async () => {
  if (process.platform === 'win32') return;
  const dir = await mktemp();
  const file = path.join(dir, 'f.txt');
  await fsp.writeFile(file, 'x', { mode: 0o644 });
  await writeAtomic(file, 'y', { mode: 0o600 });
  const stat = await fsp.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('writeAtomic: creates parent directory if missing', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'a', 'b', 'c.txt');
  await writeAtomic(file, 'deep');
  assert.equal(await fsp.readFile(file, 'utf8'), 'deep');
});

test('readJson + writeJson: round-trip preserves structure', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'data.json');
  const obj = { name: 'foo', count: 3, nested: { ok: true } };
  await writeJson(file, obj);
  const back = await readJson(file);
  assert.deepEqual(back, obj);
});

test('writeJson: pretty-prints with trailing newline', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'data.json');
  await writeJson(file, { a: 1 });
  const txt = await fsp.readFile(file, 'utf8');
  assert.equal(txt, '{\n  "a": 1\n}\n');
});

test('writeJson: respects mode option', async () => {
  if (process.platform === 'win32') return;
  const dir = await mktemp();
  const file = path.join(dir, 'data.json');
  await writeJson(file, { x: 1 }, { mode: 0o600 });
  const stat = await fsp.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('readText: reads UTF-8 string', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 't.txt');
  await fsp.writeFile(file, 'hello 中文');
  assert.equal(await readText(file), 'hello 中文');
});

test('sha256: deterministic hex digest', () => {
  const h = sha256('hello');
  assert.equal(h, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(sha256('hello'), sha256('hello'));
  assert.notEqual(sha256('hello'), sha256('world'));
});

test('sha256File: matches sha256 over file bytes', async () => {
  const dir = await mktemp();
  const file = path.join(dir, 'h.txt');
  await fsp.writeFile(file, 'payload');
  assert.equal(await sha256File(file), sha256('payload'));
});

test('copyFileMode: copies file and sets mode', async () => {
  if (process.platform === 'win32') return;
  const dir = await mktemp();
  const src = path.join(dir, 'src.txt');
  const dst = path.join(dir, 'sub', 'dst.txt');
  await fsp.writeFile(src, 'data');
  await copyFileMode(src, dst, 0o600);
  assert.equal(await fsp.readFile(dst, 'utf8'), 'data');
  const stat = await fsp.stat(dst);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('expandTilde: expands ~ and ~/ but leaves others', () => {
  assert.equal(expandTilde('~'), os.homedir());
  assert.equal(expandTilde('~/foo'), path.join(os.homedir(), 'foo'));
  assert.equal(expandTilde('/abs/path'), '/abs/path');
  assert.equal(expandTilde('relative'), 'relative');
  assert.equal(expandTilde(''), '');
  assert.equal(expandTilde(null), null);
});

test('isoStamp: produces ISO 8601 with colons replaced', () => {
  const s = isoStamp(new Date('2026-05-17T10:30:45.123Z'));
  assert.equal(s, '2026-05-17T10-30-45.123Z');
  assert.match(isoStamp(), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
});
