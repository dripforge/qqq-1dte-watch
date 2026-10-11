import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
test('exclusive lock rejects a live owner and release checks token', () => {
  const root = mkdtempSync(join(tmpdir(), 'qqq-lock-')); const path = join(root, 'lock');
  try {
    const release = acquireProcessLock(path);
    assert.throws(() => acquireProcessLock(path), /live process/);
    const owner = JSON.parse(readFileSync(path));
    writeFileSync(path, JSON.stringify({ ...owner, token: 'replacement' }));
    release(); assert.ok(existsSync(path));
  } finally { rmSync(root, { recursive: true }); }
});
test('recovers a verified dead owner but refuses malformed locks', () => {
  const root = mkdtempSync(join(tmpdir(), 'qqq-lock-')); const path = join(root, 'lock');
  try {
    writeFileSync(path, JSON.stringify({ pid: 123456, token: 'old' }));
    const release = acquireProcessLock(path, { isAlive: () => false });
    assert.equal(JSON.parse(readFileSync(path)).pid, process.pid);
    release(); assert.equal(existsSync(path), false);
    writeFileSync(path, '');
    assert.throws(() => acquireProcessLock(path, { isAlive: () => false }));
    assert.ok(existsSync(path));
  } finally { rmSync(root, { recursive: true }); }
});
