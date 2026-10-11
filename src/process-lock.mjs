import { randomUUID } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
function owner(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string' || !value.token) {
    throw new Error('Lock owner is malformed; inspect it before continuing');
  }
  return value;
}

export function acquireProcessLock(path, { pid = process.pid, isAlive = alive } = {}) {
  const value = { pid, token: randomUUID(), at: new Date().toISOString() };
  function create() {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); } finally { closeSync(fd); }
  }
  try { create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recovery = `${path}.recovery`;
    let fd;
    try {
      fd = openSync(recovery, 'wx', 0o600);
      const current = owner(path);
      if (isAlive(current.pid)) throw new Error(`A live process owns ${path}`);
      // The recovery guard elects one remover. A normal competing creator may
      // win after removal, but this remover never removes its new lock.
      unlinkSync(path);
      create();
    } finally {
      if (fd !== undefined) { closeSync(fd); unlinkSync(recovery); }
    }
  }
  return () => {
    try {
      const current = owner(path);
      if (current.pid === value.pid && current.token === value.token) unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
