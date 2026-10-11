import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEntryResearchEvent, buildProfitResearchEvent, safeRecordResearchEvent } from './research-hooks.mjs';
import { validateResearchEvent } from './research-policy.mjs';
import { AT, ID, TRADE, iso, setup, trail } from './research-fixtures.mjs';

const now = Date.parse(AT);
const qqq = { last_trade_price: '499.7', venue_last_trade_time: AT, symbol: 'QQQ' };
const option = { instrument_id: ID, bid_price: '1.9', ask_price: '2.0',
  bid_size: '40', ask_size: '20', updated_at: AT, delta: '-0.48', theta: '-0.20' };
const instrument = { id: ID, expiration_date: '2026-10-09', strike_price: '500.0000' };
test('entry hook captures verified data before submission and records afterward without losing original timestamps', t => {
  const folder = mkdtempSync(join(tmpdir(), 'qqq-hooks-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const evidence = setup();
  delete evidence.setup.next_obstacle;
  const event = buildEntryResearchEvent({ now, direction: 'put', qqqInvalidation: 500.5,
    qqq, option, instrument, setup: { ...evidence.setup, level: 500 },
    oneMinuteBars: evidence.one_minute_bars, fiveMinuteBars: evidence.five_minute_bars });
  assert.ok(event);
  const afterSubmission = safeRecordResearchEvent(event, { folder, now: now + 20000 });
  assert.equal(afterSubmission.status, 'recorded');
  const record = JSON.parse(readFileSync(join(folder, 'research-journal.jsonl'), 'utf8'));
  assert.equal(Date.parse(record.observed_at), now);
  assert.equal(record.recorded_at, '2026-10-08T18:00:22.000Z');
  assert.equal(record.selected_contract.quote_usable, true);
  assert.equal(record.selected_contract.updated_at, AT);
  assert.equal(record.selected_contract.delta, -.48);
  assert.equal(record.measurements.next_obstacle, undefined);
  assert.equal(record.measurements.room_to_obstacle, null);
});
test('profit hook matches prompt case identity, drops unfinished bars and leaves missing strike explicitly unpriced', () => {
  const evidence = trail();
  const arm = { option_id: ID, option_type: 'call', expiration_date: '2026-10-09',
    contract_strike: 500, opened_at: iso(49), trade_id: TRADE };
  const event = buildProfitResearchEvent({ now, arm, qqq: { ...qqq, last_trade_price: '500' },
    option: { ...option, delta: '0.48' }, oneMinuteBars: [...evidence.one_minute_bars,
      { ...evidence.one_minute_bars.at(-1), begins_at: iso(60) }], fiveMinuteBars: evidence.five_minute_bars });
  assert.ok(event);
  assert.equal(event.one_minute_bars.length, 10);
  assert.equal(validateResearchEvent(event, now).case_id, validateResearchEvent(evidence, now).case_id);
  delete arm.contract_strike;
  const unavailable = buildProfitResearchEvent({ now, arm, qqq, option,
    oneMinuteBars: evidence.one_minute_bars, fiveMinuteBars: evidence.five_minute_bars });
  assert.ok(unavailable);
  assert.equal(unavailable.selected_contract, null);
  assert.ok(validateResearchEvent(unavailable, now).missing_data.includes('fresh_selected_option_quote'));
});
test('bad research metadata and persistence errors return optional skips without throwing', () => {
  assert.equal(buildEntryResearchEvent({ now, direction: 'put', setup: {} }), null);
  assert.equal(buildProfitResearchEvent({ now, arm: { trade_id: null } }), null);
  assert.deepEqual(safeRecordResearchEvent(null), { status: 'research_skipped',
    reason: 'Verified research evidence unavailable', execution_unaffected: true });
  const evidence = setup();
  const event = buildEntryResearchEvent({ now, direction: 'put', qqqInvalidation: 500.5,
    qqq, option, instrument, setup: { ...evidence.setup, level: 500 },
    oneMinuteBars: evidence.one_minute_bars, fiveMinuteBars: evidence.five_minute_bars });
  assert.doesNotThrow(() => safeRecordResearchEvent(event, { folder: '/path/does/not/exist', now }));
  assert.equal(safeRecordResearchEvent(event, { folder: '/path/does/not/exist', now }).status, 'research_skipped');
});
test('research preserves available optional Greeks and activity without extra market calls',()=>{
 const evidence=setup();const event=buildEntryResearchEvent({now,direction:'put',qqqInvalidation:500.5,qqq,
 option:{...option,gamma:'0.06',vega:'0.27',implied_volatility:'0.095',volume:25000,open_interest:626},instrument,
 setup:{...evidence.setup,level:500},oneMinuteBars:evidence.one_minute_bars,fiveMinuteBars:evidence.five_minute_bars});
 const result=validateResearchEvent(event,now).selected_contract;assert.equal(result.gamma,.06);assert.equal(result.vega,.27);assert.equal(result.implied_volatility,.095);assert.equal(result.volume,25000);assert.equal(result.open_interest,626);
 const legacy=validateResearchEvent(setup(),now).selected_contract;assert.equal(legacy.gamma,null);
});
