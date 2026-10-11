import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = dirname(SOURCE_DIR);
export const DEFAULT_RUNTIME_DIR = join(PROJECT_DIR, 'runtime');

function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonical(dirname(path)), relative(dirname(path), path));
}
const within = (parent, child) => {
  const suffix = relative(parent, child);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
};

/** Resolve private state independently of cwd; never reuse source-adjacent state. */
export function runtimeDirectory(value, { env = process.env, create = true } = {}) {
  const configured = value ?? env.QQQ_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR;
  if (typeof configured !== 'string' || !configured.trim() || !isAbsolute(configured)) {
    throw new Error('Runtime directory must be an absolute path');
  }
  const folder = canonical(resolve(configured));
  const project = canonical(PROJECT_DIR);
  const permitted = ['runtime','artifacts'].map(name=>join(project,name));
  if (within(folder, project) || (within(project, folder) && !permitted.some(parent=>within(parent, folder)))) {
    throw new Error('Runtime state must be outside source directories; use runtime/, artifacts/ or an external directory');
  }
  if (create) mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}
