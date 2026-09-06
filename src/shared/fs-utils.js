import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

export async function writeJson(file, obj, options = {}) {
  const txt = JSON.stringify(obj, null, 2) + '\n';
  await writeAtomic(file, txt, options);
}

export async function readText(file) {
  return fsp.readFile(file, 'utf8');
}

/**
 * Write `content` to `file` via a same-directory temp file + rename.
 *
 * Mode resolution:
 *   - `options.mode` given → use it.
 *   - else target already exists → preserve its current permission bits.
 *     Codex writes ~/.codex/config.toml as 0600; rename() would otherwise
 *     replace it with a fresh 0644 inode and silently widen the permissions.
 *   - else → process default (0666 & ~umask).
 */
export async function writeAtomic(file, content, options = {}) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.codexx-tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  let mode = options.mode;
  if (mode === undefined) {
    try {
      mode = (await fsp.stat(file)).mode & 0o777;
    } catch {
      // target does not exist yet — fall through to the process default
    }
  }
  let fd;
  try {
    fd = await fsp.open(tmp, 'w', mode);
    await fd.writeFile(content, 'utf8');
    await fd.sync();
  } finally {
    if (fd) await fd.close();
  }
  await fsp.rename(tmp, file);
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export async function sha256File(file) {
  const buf = await fsp.readFile(file);
  return sha256(buf);
}

export async function copyFileMode(src, dst, mode) {
  await ensureDir(path.dirname(dst));
  await fsp.copyFile(src, dst);
  if (mode !== undefined) await fsp.chmod(dst, mode);
}

export function expandTilde(p) {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function isoStamp(d = new Date()) {
  return d.toISOString().replaceAll(':', '-');
}
