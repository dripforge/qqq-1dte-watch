import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJournal, readJournal, journalDailyRealized } from './journal.mjs';
test('journal retains event evidence, avoids account secrets and counts duplicate closes once', () => {
  const root = mkdtempSync(join(tmpdir(), 'qqq-journal-'));
  try {
    assert.equal(journalDailyRealized(root, '2026-10-08'), null);
    const close = { trade_id: 'trade1', option_id: 'option1', closed_at: '2026-10-08T15:51:00Z',
      realized_pnl: -16, pnl_basis: 'broker_reported' };
    appendJournal(root, 'trade_closed', close); appendJournal(root, 'trade_closed', close);
    assert.deepEqual(journalDailyRealized(root, '2026-10-08'), { realized_pnl: -16, number_of_trades: 1, pnl_basis: 'broker_reported' });
    assert.equal(readJournal(root).length, 2);
    assert.throws(() => appendJournal(root, 'read', { nested: { rhs_account_number: 'secret' } }), /credentials/);
    appendJournal(root, 'trade_closed', { ...close, realized_pnl: -17 });
    assert.throws(() => journalDailyRealized(root, '2026-10-08'), /Conflicting/);
  } finally { rmSync(root, { recursive: true }); }
});

test('gross fill-premium P&L is explicitly labeled while fees are unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'qqq-journal-'));
  try {
    appendJournal(root, 'trade_closed', { trade_id: 'gross1', option_id: 'option1',
      closed_at: '2026-10-08T15:51:00Z', realized_pnl: -16, pnl_basis: 'fill_premiums_gross', fees: null });
    assert.deepEqual(journalDailyRealized(root, '2026-10-08'), {
      realized_pnl: -16, number_of_trades: 1, pnl_basis: 'fill_premiums_gross' });
  } finally { rmSync(root, { recursive: true }); }
});
