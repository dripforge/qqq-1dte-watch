import { requireConfiguredAccount } from './broker-config.mjs';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, connectReadOnly } from './mcp.mjs';
import { validateArm } from './logic.mjs';
import { marketSession, sessionForDate } from './session.mjs';
import { bufferedInvalidationBoundary, requireBufferedInvalidation } from './invalidation.mjs';
import { validateSetup } from './setup-policy.mjs';
import { brokerDailyRealized, reserveRisk } from './risk-policy.mjs';
import { loadApprovedRiskPolicy, assertApprovedRiskPolicy } from './approved-risk-policy.mjs';
import { assessServiceHealth } from './service-health.mjs';
import { appendJournal, journalDailyRealized } from './journal.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { isWorkingOrder } from './order-state.mjs';
import { prepareEntryIntent, dispatchEntry, validateEntryIntent } from './entry-recovery.mjs';
import { buildEntryResearchEvent, safeRecordResearchEvent } from './research-hooks.mjs';
import { createProfitProtectionPlan, validateProfitProtectionEvidence, validateProfitProtectionPlan } from './profit-protection.mjs';
import { requireFreshReentry,recentExitContext } from './reentry.mjs';
import {assertFlatPositionSnapshot} from './owned-dispatch.mjs';
import {validatePositionSnapshot} from './position-ownership.mjs';
import {requireNearMoneyContract} from './contract-selection.mjs';
import {readEntryWatchPlan,readEntryWatchState,validateEntryWatchClaim,entryAttemptPrevious,assertDirectEntryPlanClear,refreshClaimedEntryEvidence} from './entry-watch-plan.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const armPath = join(root, 'arm.json');
const intentPath = join(root, 'entry-intent.json');
const lockPath = join(root, 'entry.lock');
const healthPath = join(root, 'health.json');
const profitPlanPath = join(root, 'profit-plan.json');
const profitRequestPath = join(root, 'profit-exit-request.json');
const profitProtectionPath = join(root, 'profit-protection-plan.json');
const profitProtectionStatePath = join(root, 'profit-protection-state.json');
const lastSetupPath = join(root, 'last-setup.json');
const args = process.argv.slice(2);
const [optionId, optionType, expiration, levelText] = args;
const setupFlag = args.indexOf('--setup-json');
const setupPath = setupFlag >= 4 && args[setupFlag + 1] ? resolve(args[setupFlag + 1]) : null;
const checkOnly = process.argv.includes('--check-only');
const entryWatchFlag=args.indexOf('--entry-watch-plan');
const entryWatchPlanId=entryWatchFlag>=4?args[entryWatchFlag+1]:null;
let approvedRiskSnapshot;
let reentryEvaluation;

function atomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
function get(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
function fail(message) { throw new Error(message); }
function asNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${name} unavailable`);
  return number;
}
function fresh(value, ageMs = 10000) {
  const age = Date.now() - Date.parse(value ?? '');
  return Number.isFinite(age) && age >= -5000 && age <= ageMs;
}
function ownMonitorReady(health, refId) {
  if (!assessServiceHealth(health, {maxAgeMs:60000}).live_verified) return false;
  if (health.status === 'idle') return true;
  const intent = get(intentPath), arm = get(armPath);
  return ['entry_preparing', 'entry_outcome_unknown'].includes(health.status) && intent?.ref_id === refId &&
    arm?.trade_id === refId && !intent?.order_id;
}
async function pages(client, name, args, key) {
  const all = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const result = await call(client, name, { ...args, ...(cursor ? { cursor } : {}) });
    if(!Array.isArray(result[key])||result[key].some(row=>!row))fail(`${name} returned an incomplete ${key} snapshot`);
    if(key==='positions')validatePositionSnapshot(result,{complete:false});
    all.push(...result[key]);
    cursor = result.next;
    if (!cursor) return all;
  }
  fail(`${name} has more than five pages; cannot verify account state`);
}

async function main() {
  if(entryWatchFlag>=0&&(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entryWatchPlanId??'')||args.filter(value=>value==='--entry-watch-plan').length!==1||checkOnly))fail('A single live entry-watch plan ID is required');
  if (!/^[0-9a-f-]{36}$/i.test(optionId ?? '')) fail('A QQQ option ID is required');
  if (!['call', 'put'].includes(optionType)) fail('Option type must be call or put');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration ?? '')) fail('Expiration must be YYYY-MM-DD');
  const invalidation = asNumber(levelText, 'QQQ invalidation');
  const now = marketSession(new Date());
  if (!now.can_enter) fail(`New entries are closed for this market session: ${now.reason}`);
  const expirySession = sessionForDate(expiration);
  if (!expirySession.verified || !expirySession.is_trading_day) fail('Expiration is not a verified trading session');
  if (!setupPath || !setupPath.startsWith(root + sep)) fail('A setup evidence file inside the monitor folder is required');
  const candidate = get(setupPath);
  validateProfitProtectionEvidence(candidate?.profit_protection);
  const approved = loadApprovedRiskPolicy(root);
  const policy = approved.policy;
  approvedRiskSnapshot = approved.snapshot;
  let fastClaim;
  function assertEntryPlanEligibility(){
    const saved=readEntryWatchPlan(root,{now:Date.now(),policySnapshot:entryWatchPlanId?approvedRiskSnapshot:undefined,
      allowExpired:!entryWatchPlanId,requireEntrySession:!!entryWatchPlanId});
    const state=readEntryWatchState(root,{plan:saved});
    if(entryWatchPlanId){
      const verified=validateEntryWatchClaim({plan:saved,state,planId:entryWatchPlanId,optionId,direction:optionType,
        expiration,invalidation,candidate:get(setupPath),policySnapshot:approvedRiskSnapshot,
        expectedAttemptId:fastClaim?.state.attempt_id});
      if(fastClaim&&(verified.plan.plan_sha256!==fastClaim.plan.plan_sha256||JSON.stringify(verified.state)!==JSON.stringify(fastClaim.state)))fail('Fast entry plan or original claim changed during checks');
      fastClaim??=verified;
    }else assertDirectEntryPlanClear({plan:saved,state});
  }
  const ownFast=()=>fastClaim?{ownPlanId:fastClaim.plan.plan_id,ownSetupId:fastClaim.setup_id,ownAttemptedAt:fastClaim.state.attempted_at}:{};
  assertEntryPlanEligibility();
  if (existsSync(armPath) || existsSync(intentPath) || existsSync(profitPlanPath) ||
      existsSync(profitRequestPath) || existsSync(profitProtectionPath) || existsSync(profitProtectionStatePath)) fail('An entry or position is already armed');
  const health = get(healthPath);
  if (!assessServiceHealth(health, {maxAgeMs:60000}).live_verified || health.status !== 'idle') {
    fail('Live exit monitor is not healthy and idle');
  }

  const client = await connectReadOnly();
  let researchEvent;
  try {
    const accounts = await call(client, 'get_accounts', {});
    const agentic = (accounts.accounts ?? []).filter(a => a?.agentic_allowed && a.state === 'active');
    requireConfiguredAccount(agentic);
    const account = agentic[0].account_number;
    const rhsAccount = agentic[0].rhs_account_number;
    if (!rhsAccount) fail('P&L account identifier unavailable');
    if (!['option_level_2', 'option_level_3'].includes(agentic[0].user_option_level ?? agentic[0].option_level)) {
      fail('Agentic account does not have options trading permission');
    }
    const [chains, instrumentResult, quoteResult, optionQuoteResult, portfolio, pnl, positions, historicals, fiveHistoricals] = await Promise.all([
      call(client, 'get_option_chains', { underlying_symbol: 'QQQ' }),
      call(client, 'get_option_instruments', { ids: optionId }),
      call(client, 'get_equity_quotes', { symbols: ['QQQ'] }),
      call(client, 'get_option_quotes', { instrument_ids: [optionId] }),
      call(client, 'get_portfolio', { account_number: account }),
      call(client, 'get_realized_pnl', { account_number: rhsAccount, span: 'day', asset_classes: ['option'], timezone: 'America/New_York' }),
      call(client, 'get_option_positions', { account_number: account, nonzero: true }),
      call(client, 'get_equity_historicals', { symbols: ['QQQ'], interval: 'minute',
        start_time: new Date(Date.now() - 30 * 60000).toISOString(), bounds: 'regular' }),
      call(client, 'get_equity_historicals', { symbols: ['QQQ'], interval: '5minute',
        start_time: new Date(Date.now() - 120 * 60000).toISOString(), bounds: 'regular' }),
    ]);
    const chain = chains.chains?.find(c => c?.symbol === 'QQQ');
    const nextExpiry = chain?.expiration_dates?.filter(date => date > now.date).sort()[0];
    if (!chain?.can_open_position || Number(chain.trade_value_multiplier) !== 100 || expiration !== nextExpiry) {
      fail('Contract is not the next available 1DTE QQQ expiration');
    }
    const instrument = instrumentResult.instruments?.find(x => x?.id === optionId);
    if (!instrument || instrument.chain_id !== chain.id || instrument.type !== optionType ||
        instrument.expiration_date !== expiration || instrument.state !== 'active' ||
        instrument.tradability !== 'tradable') fail('Option instrument does not match the proposed QQQ contract');
    assertFlatPositionSnapshot(positions);
    const orders = await pages(client, 'get_option_orders', { account_number: account, chain_ids: chain.id }, 'orders');
    if (orders.some(isWorkingOrder)) fail('A QQQ option order is already working');

    const qqq = quoteResult.results?.find(x => x?.quote?.symbol === 'QQQ')?.quote;
    const stockPrice = asNumber(qqq?.last_trade_price, 'QQQ price');
    if (qqq?.state !== 'active' || !qqq?.has_traded || !fresh(qqq.venue_last_trade_time)) fail('QQQ quote is stale');
    if ((optionType === 'call' && invalidation >= stockPrice) ||
        (optionType === 'put' && invalidation <= stockPrice) ||
        Math.abs(stockPrice - invalidation) > stockPrice * 0.01) fail('QQQ invalidation is not a nearby adverse level');
    const bars = historicals.results?.find(x => x?.symbol === 'QQQ')?.bars;
    const previousSetup = entryAttemptPrevious(get(lastSetupPath),get(join(root,'entry-watch-last-attempt.json')),ownFast());
    const freshCandidate=fastClaim?refreshClaimedEntryEvidence(candidate,fastClaim,{oneMinuteBars:bars}):candidate;
    const setup = validateSetup(freshCandidate, { direction: optionType, oneMinuteBars: bars,
      fiveMinuteBars: fiveHistoricals.results?.find(x => x?.symbol === 'QQQ')?.bars,
      previous: previousSetup });
    reentryEvaluation=requireFreshReentry(get(join(root,'last-exit.json')),setup);
    if(optionType==='call'?stockPrice<=setup.level:stockPrice>=setup.level)fail('QQQ has returned across the setup reference level');
    const boundary = bufferedInvalidationBoundary(bars, optionType);
    requireBufferedInvalidation(invalidation, optionType, boundary.boundary);
    const strike = asNumber(instrument.strike_price, 'Strike');
    const contractSelection=requireNearMoneyContract({direction:optionType,strike,qqqPrice:stockPrice});
    const option = optionQuoteResult.results?.find(x => x?.quote?.instrument_id === optionId)?.quote;
    if (!fresh(option?.updated_at)) fail('Option quote is stale');
    const ask = asNumber(option.ask_price, 'Option ask');
    const bid = asNumber(option.bid_price, 'Option bid');
    if (bid <= 0 || ask < bid || ask <= 0 || !Number.isFinite(Number(option.ask_size)) || !Number.isFinite(Number(option.bid_size)) || Number(option.ask_size) < 1 || Number(option.bid_size) < 1) {
      fail('Option market is not liquid');
    }
    if (ask - bid > Math.min(0.10, (ask + bid) / 2 * 0.05) + 1e-8) fail('Option spread exceeds 5% of midpoint or $0.10');
    const risk = reserveRisk({ portfolio, premium: ask, brokerRealized: brokerDailyRealized(pnl),
      localRealized: journalDailyRealized(root, now.date), policy });

    const arm = validateArm({ option_id: optionId, option_type: optionType,
      expiration_date: expiration, qqq_invalidation: invalidation,
      entry_premium: ask, quantity: 1, setup_id: setup.setup_id, setup_level: setup.level,
      setup_break_bar_at: setup.break_bar_at,setup_confirmation_1m_at:setup.confirmation_1m_at });
    if (checkOnly) {
      process.stdout.write(JSON.stringify({ status: 'eligible', qqq_price: stockPrice,
        limit_price: ask.toFixed(2), setup_id: setup.setup_id, risk,
        policy_snapshot: approvedRiskSnapshot, session: now, reentry:reentryEvaluation,contract_selection:contractSelection,profit_protection_mode: candidate.profit_protection.mode }) + '\n');
      return;
    }
    const refId = randomUUID();
    arm.trade_id=refId;
    arm.contract_strike=strike;
    const profitProtectionPlan=createProfitProtectionPlan({arm,evidence:candidate.profit_protection});
    const preparedIntent={...prepareEntryIntent({ arm, setupId: setup.setup_id, policySnapshot: approvedRiskSnapshot }),
      setup_evidence:setup,
      ...(fastClaim?{entry_watch_plan_id:fastClaim.plan.plan_id,entry_watch_attempt_id:fastClaim.state.attempt_id,
        entry_watch_evidence_sha256:fastClaim.state.activation_evidence_sha256}:{} )};
    researchEvent=buildEntryResearchEvent({now:Date.now(),direction:optionType,qqqInvalidation:invalidation,
      qqq,option,instrument,setup,oneMinuteBars:bars,
      fiveMinuteBars:fiveHistoricals.results?.find(x=>x?.symbol==='QQQ')?.bars,tradeId:refId});
    appendJournal(root, 'entry_qualified', { trade_id: refId, option_id: optionId, setup,
      arm, risk, contract_selection:contractSelection,reentry:reentryEvaluation,profit_protection:profitProtectionPlan, policy_snapshot: approvedRiskSnapshot, session: now, qqq_quote: qqq, option_quote: option,
      broker_1m_bars: bars, broker_5m_bars: fiveHistoricals.results?.find(x => x?.symbol === 'QQQ')?.bars });
    const releaseState=acquireProcessLock(join(root,'state.lock'));
    try {
    const currentTime=marketSession(new Date()),currentHealth=get(healthPath);
    if(!currentTime.can_enter||currentTime.date!==now.date)fail('Entry window changed during checks');
    assertApprovedRiskPolicy(root, approvedRiskSnapshot);
    assertEntryPlanEligibility();
    if(!fresh(qqq.venue_last_trade_time)||!fresh(option.updated_at)||!assessServiceHealth(currentHealth,{maxAgeMs:60000}).live_verified||currentHealth.status!=='idle')fail('Entry quotes or monitor became stale during checks');
    if(existsSync(armPath)||existsSync(intentPath)||existsSync(profitPlanPath)||existsSync(profitRequestPath)||existsSync(profitProtectionPath)||existsSync(profitProtectionStatePath))fail('Position state changed during entry checks');
    atomic(lastSetupPath, { setup_id: setup.setup_id, break_bar_at: setup.break_bar_at,
      direction: optionType, attempted_at: new Date().toISOString(), trade_id: refId });
    atomic(armPath, arm);
    atomic(intentPath, preparedIntent);
    atomic(profitProtectionPath, profitProtectionPlan);
    } finally {releaseState();}
    let dispatchQQQ = qqq, dispatchOption = option;
    async function refreshRetryEligibility() {
      assertEntryPlanEligibility();
      const session = marketSession(new Date());
      if (!session.can_enter || session.date !== now.date) fail('Original entry retry is outside its entry session');
      const approved = assertApprovedRiskPolicy(root, approvedRiskSnapshot);
      const currentAccounts = await call(client, 'get_accounts', {});
      const currentAccount = (currentAccounts.accounts ?? []).filter(value => value?.agentic_allowed && value.state === 'active');
      if (currentAccount.length !== 1 || currentAccount[0].account_number !== account || currentAccount[0].rhs_account_number !== rhsAccount ||
          !['option_level_2', 'option_level_3'].includes(currentAccount[0].user_option_level ?? currentAccount[0].option_level)) fail('Original retry account or options permission changed');
      const [currentChains, currentInstruments, currentQQQ, currentOption, currentPortfolio, currentPnl, minuteHistory, fiveHistory] = await Promise.all([
        call(client, 'get_option_chains', {underlying_symbol:'QQQ'}),
        call(client, 'get_option_instruments', {ids:optionId}),
        call(client, 'get_equity_quotes', {symbols:['QQQ']}),
        call(client, 'get_option_quotes', {instrument_ids:[optionId]}),
        call(client, 'get_portfolio', {account_number:account}),
        call(client, 'get_realized_pnl', {account_number:rhsAccount,span:'day',asset_classes:['option'],timezone:'America/New_York'}),
        call(client, 'get_equity_historicals', {symbols:['QQQ'],interval:'minute',start_time:new Date(Date.now()-30*60000).toISOString(),bounds:'regular'}),
        call(client, 'get_equity_historicals', {symbols:['QQQ'],interval:'5minute',start_time:new Date(Date.now()-120*60000).toISOString(),bounds:'regular'}),
      ]);
      const currentChain = currentChains.chains?.find(value => value?.symbol === 'QQQ');
      if (!currentChain?.can_open_position || currentChain.id !== chain.id || Number(currentChain.trade_value_multiplier) !== 100 ||
          currentChain.expiration_dates?.filter(date => date > session.date).sort()[0] !== expiration) fail('Original retry QQQ expiry or chain changed');
      const currentInstrument = currentInstruments.instruments?.find(value => value?.id === optionId);
      if (!currentInstrument || currentInstrument.chain_id !== chain.id || currentInstrument.type !== optionType ||
          currentInstrument.expiration_date !== expiration || currentInstrument.state !== 'active' || currentInstrument.tradability !== 'tradable') fail('Original retry instrument is no longer eligible');
      const allPositions = await pages(client, 'get_option_positions', {account_number:account,nonzero:true}, 'positions');
      const allOrders = await pages(client, 'get_option_orders', {account_number:account,chain_ids:chain.id}, 'orders');
      assertFlatPositionSnapshot({positions:allPositions});
      if (allOrders.some(isWorkingOrder)) fail('Original retry is blocked by an open QQQ position or working order; uncertain intent retained');
      dispatchQQQ = currentQQQ.results?.find(value => value?.quote?.symbol === 'QQQ')?.quote;
      dispatchOption = currentOption.results?.find(value => value?.quote?.instrument_id === optionId)?.quote;
      const currentStock = asNumber(dispatchQQQ?.last_trade_price,'Retry QQQ price');
      if (dispatchQQQ?.state !== 'active' || !dispatchQQQ?.has_traded || !fresh(dispatchQQQ.venue_last_trade_time) || !fresh(dispatchOption?.updated_at)) fail('Original retry quotes are stale');
      requireNearMoneyContract({direction:optionType,strike:asNumber(currentInstrument.strike_price,'Retry strike'),qqqPrice:currentStock});
      if ((optionType==='call' ? invalidation >= currentStock : invalidation <= currentStock) || Math.abs(currentStock-invalidation)>currentStock*0.01) fail('Original retry invalidation or strike is no longer eligible');
      const retryBars = minuteHistory.results?.find(value => value?.symbol === 'QQQ')?.bars;
      const retryCandidate=fastClaim?refreshClaimedEntryEvidence(candidate,fastClaim,{oneMinuteBars:retryBars}):candidate;
      const retrySetup = validateSetup(retryCandidate,{direction:optionType,oneMinuteBars:retryBars,
        fiveMinuteBars:fiveHistory.results?.find(value => value?.symbol === 'QQQ')?.bars,
        previous:entryAttemptPrevious(previousSetup,get(join(root,'entry-watch-last-attempt.json')),ownFast())});
      if (retrySetup.setup_id !== setup.setup_id || (optionType==='call' ? currentStock<=setup.level : currentStock>=setup.level)) fail('Original completed setup no longer qualifies');
      requireBufferedInvalidation(invalidation,optionType,bufferedInvalidationBoundary(retryBars,optionType).boundary);
      const currentAsk = asNumber(dispatchOption.ask_price,'Retry option ask'), currentBid = asNumber(dispatchOption.bid_price,'Retry option bid');
      if (currentBid<=0 || currentAsk<currentBid || currentAsk>ask || !Number.isFinite(Number(dispatchOption.ask_size)) ||
          !Number.isFinite(Number(dispatchOption.bid_size)) || Number(dispatchOption.ask_size)<1 || Number(dispatchOption.bid_size)<1 ||
          currentAsk-currentBid>Math.min(0.10,(currentAsk+currentBid)/2*0.05)+1e-8) fail('Original retry option market is no longer eligible at the saved limit');
      reserveRisk({portfolio:currentPortfolio,premium:ask,brokerRealized:brokerDailyRealized(currentPnl),
        localRealized:journalDailyRealized(root,session.date),policy:approved.policy});
      if(fastClaim){
        atomic(intentPath,{...get(intentPath),retry_setup_evidence:retrySetup,retry_setup_checked_at:new Date().toISOString()});
        appendJournal(root,'entry_watch_retry_setup_verified',{trade_id:refId,plan_id:fastClaim.plan.plan_id,
          attempt_id:fastClaim.state.attempt_id,original_activation_evidence_sha256:fastClaim.state.activation_evidence_sha256,
          setup:retrySetup});
      }
    }
    function finalPreflight() {
      try {
        const current=marketSession(new Date()), currentHealth=get(healthPath);
        assertApprovedRiskPolicy(root, approvedRiskSnapshot);
        assertEntryPlanEligibility();
        const latestAttempt=entryAttemptPrevious(previousSetup,get(join(root,'entry-watch-last-attempt.json')),ownFast());
        if(latestAttempt&&Date.parse(setup.break_bar_at)<=Date.parse(latestAttempt.break_bar_at))throw Error('A newer fast or direct attempt consumed this completed break');
        requireNearMoneyContract({direction:optionType,strike,qqqPrice:asNumber(dispatchQQQ?.last_trade_price,'Dispatch QQQ price')});
        if(ask*100>policy.opening_premium_ceiling+1e-8)throw Error('Saved entry limit exceeds current approved premium ceiling');
        validateProfitProtectionPlan(get(profitProtectionPath),{arm});
        if(JSON.stringify(get(profitProtectionPath))!==JSON.stringify(profitProtectionPlan))throw new Error('Agent-selected entry profit protection plan changed before submission');
        if(!current.can_enter||current.date!==now.date||!fresh(dispatchQQQ?.venue_last_trade_time)||!fresh(dispatchOption?.updated_at)||
          !ownMonitorReady(currentHealth,refId) || get(armPath)?.trade_id !== refId || get(intentPath)?.ref_id !== refId) {
          throw new Error('Entry session, quotes or exit monitor changed before submission');
        }
      } catch (error) { error.code='LOCAL_PREFLIGHT';throw error; }
    }
    const performDispatch = retry => dispatchEntry({intent:get(intentPath),arm,save:value=>atomic(intentPath,{...get(intentPath),...value}),retry,
      place:(saved,beforeSend)=>call(client,'place_option_order',{account_number:account,...saved},{beforeSend:async({read})=>{
        finalPreflight();
        const snapshot=await read('get_option_positions',{account_number:account,nonzero:true});
        assertFlatPositionSnapshot(snapshot);
        beforeSend();
      }}),
      preflight:({beforeSend})=>beforeSend ? finalPreflight() : retry ? refreshRetryEligibility() : undefined});
    let placed;
    try { placed = await performDispatch(false); }
    catch(error) {
      const intent = get(intentPath);
      if (!intent?.dispatch_started_at) {
        atomic(intentPath,{...intent,local_not_sent:true,dispatch_phase:'local_not_sent',block_reason:String(error.message).slice(0,200)});
        throw error;
      }
      // A transport failure cannot prove non-submission. The single permitted
      // replay uses the exact original client reference, arguments and full guards.
      validateEntryIntent(intent,arm);
      appendJournal(root,'entry_response_unknown',{trade_id:refId,option_id:optionId,policy_snapshot:approvedRiskSnapshot,
        dispatch_attempts:intent.dispatch_attempts,reason:String(error.message).slice(0,200)});
      try { placed = await performDispatch(true); }
      catch(retryError) {
        appendJournal(root,'entry_retry_blocked',{trade_id:refId,option_id:optionId,policy_snapshot:approvedRiskSnapshot,
          dispatch_attempts:get(intentPath)?.dispatch_attempts,reason:String(retryError.message).slice(0,200)});
        throw retryError;
      }
    }
    const orderId = placed.order?.id;
    if (!orderId) fail('Buy response did not include an order ID; entry intent remains for investigation');
    appendJournal(root, 'entry_submitted', { trade_id: refId, option_id: optionId,
      setup_id: setup.setup_id, policy_snapshot: approvedRiskSnapshot, order_id: orderId, order_state: placed.order?.state, limit_price: ask });
    if(reentryEvaluation?.context)appendJournal(root,'reentry_evaluation',{trade_id:refId,option_id:optionId,status:'entry_submitted',...reentryEvaluation});
    process.stdout.write(JSON.stringify({ status: 'buy_submitted', order_state: placed.order?.state,
      contract: optionId, limit_price: ask.toFixed(2) }) + '\n');
  } finally {
    try { await client.close(); }
    finally { if(researchEvent)safeRecordResearchEvent(researchEvent,{folder:root,now:Date.now()}); }
  }
}

let release;
try {
  release = acquireProcessLock(lockPath);
  await main();
} catch (error) {
  try { appendJournal(root, 'entry_blocked', { option_id: optionId, direction: optionType,
    reason: String(error.message).slice(0, 300), check_only: checkOnly,
    policy_snapshot: approvedRiskSnapshot ?? null,
    reentry:reentryEvaluation??recentExitContext(get(join(root,'last-exit.json'))) }); } catch {}
  process.stderr.write(`Entry blocked: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (release) release();
}
