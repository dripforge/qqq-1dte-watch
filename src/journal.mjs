import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { etParts } from './logic.mjs';

function safe(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, inner] of Object.entries(value)) {
    if (/account_number|rhs_account|access_token|refresh_token|authorization|client_secret/i.test(key)) {
      throw new Error('Journal must not include account identifiers or credentials');
    }
    safe(inner);
  }
}
export function appendJournal(root, event, details = {}) {
  if (typeof event !== 'string' || !event) throw new Error('Journal event is required');
  safe(details);
  const record = { ...details, version: 1, at: new Date().toISOString(), event };
  appendFileSync(join(root, 'journal.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}
export function readJournal(root) {
  const path = join(root, 'journal.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export function journalDailyRealized(root, date) {
  const trades = new Map();
  const bases = new Set();
  for (const event of readJournal(root)) {
    if (event.event !== 'trade_closed') continue;
    if (!event.trade_id || !event.option_id || !Number.isFinite(Date.parse(event.closed_at ?? ''))) {
      throw new Error('Closed trade journal record is incomplete');
    }
    if (etParts(new Date(event.closed_at)).date !== date) continue;
    if (event.realized_pnl === null || event.realized_pnl === undefined || event.realized_pnl === '') {
      throw new Error('Closed trade realized P&L is unavailable');
    }
    const pnl = Number(event.realized_pnl);
    if (!Number.isFinite(pnl)) throw new Error('Closed trade realized P&L is invalid');
    // Gross fill-premium P&L is useful for a conservative loss check while a
    // broker summary catches up. It is explicitly not a fee-inclusive return.
    if (!['broker_reported', 'net_after_fees', 'fill_premiums_gross', 'broker_position_cost_unknown_fees'].includes(event.pnl_basis)) throw new Error('Closed trade P&L basis is unknown');
    bases.add(event.pnl_basis);
    if (trades.has(event.trade_id) && trades.get(event.trade_id) !== pnl) throw new Error('Conflicting closed trade journal records');
    trades.set(event.trade_id, pnl);
  }
  return trades.size ? { realized_pnl: [...trades.values()].reduce((a, b) => a + b, 0),
    number_of_trades: trades.size, pnl_basis: bases.size === 1 ? [...bases][0] : 'mixed_known' } : null;
}
