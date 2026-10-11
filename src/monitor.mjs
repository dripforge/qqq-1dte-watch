import { VERSION } from './version.mjs';
import { runtimeDirectory } from './runtime-paths.mjs';
import { requireConfiguredAccount } from './broker-config.mjs';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, connectReadOnly } from './mcp.mjs';
import { validateArm } from './logic.mjs';
import { marketSession, expirationStatus } from './session.mjs';
import { sessionSubmissionGuard } from './session-guard.mjs';
import { pendingClose, submitExit } from './orderflow.mjs';
import { isVerifiedZeroFillTerminal } from './order-state.mjs';
import { decideExit } from './decision.mjs';
import { ensureStop } from './emergency.mjs';
import { matchingClosingFill } from './closure.mjs';
import { appendJournal } from './journal.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { optionQuoteReader } from './option-quote-reader.mjs';
import { protectedDecision } from './protection.mjs';
import { recoverEntry, verifiedPositionEntryBasis, validateEntryIntent, priorityEntryExit } from './entry-recovery.mjs';
import {confirmPositionOwnership,assertPositionOwnership,positionFromCompleteSnapshot,validatePositionSnapshot} from './position-ownership.mjs';
import {evaluateProfitProtection} from './profit-protection.mjs';
import {verifiedExitContext} from './reentry.mjs';
import {createOwnershipDispatchGuard} from './owned-dispatch.mjs';
import {researchTradeSample} from './research-trade-sample.mjs';

const root = runtimeDirectory();
const path = name => join(root, name);
const live = process.argv.includes('--live');
const once = process.argv.includes('--once');
const INTERVAL_MS = 5000;
function json(name) { return existsSync(path(name)) ? JSON.parse(readFileSync(path(name), 'utf8')) : null; }
function atomic(name, data) {
  const tmp = `${path(name)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path(name));
}
function archiveClosed() {
  const releaseState=acquireProcessLock(path('state.lock'));
  try {
  const dir = path('history'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const files = { 'arm.json':'arm', 'entry-intent.json':'entry', 'exit-intent.json':'exit',
    'stop-intent.json':'stop', 'profit-plan.json':'profit-plan', 'profit-exit-request.json':'profit-request',
    'invalidation-cross.json':'invalidation-cross', 'trade-stats.json':'stats',
    'profit-protection-plan.json':'profit-protection-plan','profit-protection-state.json':'profit-protection-state' };
  for (const [file, suffix] of Object.entries(files)) if (existsSync(path(file))) renameSync(path(file),join(dir,`${stamp}-${suffix}.json`));
  } finally {releaseState();}
}
function health(status, extra = {}) { atomic('health.json', { at:new Date().toISOString(), version:VERSION, status, live, ...extra }); }
let previousEvent;
function log(event, extra = {}) {
  const key=JSON.stringify({event,...extra});
  if(key===previousEvent)return; previousEvent=key;
  process.stdout.write(JSON.stringify({ at:new Date().toISOString(), event, ...extra })+'\n');
}
async function paged(client, name, args, key) {
  const all=[];let cursor;
  for(let page=0;page<5;page++) {
    const result=await call(client,name,{...args,...(cursor?{cursor}:{})});
    if(!Array.isArray(result[key])||result[key].some(row=>!row))throw Error(`${name} returned an incomplete ${key} snapshot`);
    if(key==='positions')validatePositionSnapshot(result,{complete:false});
    all.push(...result[key]);
    if(!result.next)return all;cursor=result.next;
  }
  throw new Error(`${name} exceeds five pages; cannot verify complete state`);
}
async function positions(client, account) {
  return paged(client,'get_option_positions',{account_number:account,nonzero:true},'positions');
}
async function positionFor(client, account, arm) {
  const all=await positions(client,account);
  const found=positionFromCompleteSnapshot({positions:all},arm);
  if(found){
    const input={arm,intent:json('entry-intent.json'),position:found};
    const confirmed=confirmPositionOwnership(input);
    if(confirmed.changed){
      const release=acquireProcessLock(path('state.lock'));
      try{
        if(json('arm.json')?.trade_id!==arm.trade_id)throw Error('Armed trade changed during ownership verification');
        atomic('arm.json',confirmed.arm);Object.assign(arm,confirmed.arm);
        appendJournal(root,'position_ownership_bound',{trade_id:arm.trade_id,option_id:arm.option_id,
          broker_opened_at:arm.broker_position_opened_at,binding_basis:arm.ownership_binding_basis});
      }finally{release();}
    }
    assertPositionOwnership({...input,arm});
  }
  return found??null;
}
function ownershipDispatchGuard(account,arm,options={}){
  return createOwnershipDispatchGuard({account,arm,load:json,...options});
}
function entryProcessActive() {
  const lock=json('entry.lock');
  if(!lock)return false;
  if(!Number.isInteger(lock.pid)||lock.pid<=0||typeof lock.token!=='string'||!lock.token)throw new Error('Entry process ownership cannot be verified');
  try{process.kill(lock.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error;}
}
async function recoveredEntry(client,account,arm) {
  const intent=json('entry-intent.json');
  if(!intent||intent.option_id!==arm.option_id)throw new Error('Original entry intent is unavailable');
  if(!intent.order_id)atomic('entry-intent.json',{...intent,entry_recovery_last_checked_at:new Date().toISOString()});
  return recoverEntry({intent,arm,entryProcessActive:entryProcessActive(),
    save:value=>atomic('entry-intent.json',{...json('entry-intent.json'),...value}),broker:{
      order:id=>order(client,account,id),
      ordersPage:args=>call(client,'get_option_orders',{account_number:account,
        chain_ids:'a95fe906-11f0-4699-bfc2-520dd706e98d',...args}),
    }});
}
async function order(client, account, id) {
  const result=await call(client,'get_option_orders',{account_number:account,order_id:id});
  return result.orders?.find(o=>o?.id===id)??null;
}
async function ordersFor(client, account, optionId) {
  // Restrict to recent orders to keep urgent exits independent of old history.
  const arm=json('arm.json');const entry=json('entry-intent.json');
  const openedAt=arm?.opened_at??entry?.created_at;
  const args={account_number:account,chain_ids:'a95fe906-11f0-4699-bfc2-520dd706e98d',
    ...(openedAt?{created_at_gte:openedAt}:{})};
  return (await paged(client,'get_option_orders',args,'orders')).filter(o=>pendingClose(o,optionId));
}
async function awaitEntry(client, account, arm) {
  const recovered=await recoveredEntry(client,account,arm),intent=json('entry-intent.json');
  if(recovered.verified_not_sent){archiveClosed();return 'entry_not_submitted';}
  if(recovered.status==='entry_preparing'||recovered.status==='entry_outcome_unknown')return recovered.status;
  const current=recovered.order;
  if(recovered.fill)return 'awaiting_filled_position';
  if(recovered.verified_zero_fill) {
    appendJournal(root,'entry_not_filled',{trade_id:arm.trade_id??intent.ref_id,option_id:arm.option_id,order_id:current.id,order_state:current.state});
    archiveClosed();return 'entry_not_filled';
  }
  if(Date.now()-Date.parse(intent.created_at)>=30000&&!['pending_cancelled','pending_canceled'].includes(current.state)) {
    await call(client,'cancel_option_order',{account_number:account,order_id:intent.order_id});
    return 'entry_cancellation_requested';
  }
  return 'entry_pending';
}
async function filledArm(client, account, arm) {
  const intent=json('entry-intent.json');
  if(!intent||intent.option_id!==arm.option_id)throw new Error('Original entry intent cannot verify the held position basis');
  validateEntryIntent(intent,arm);
  if(!intent.order_id&&arm.entry_basis_verified&&Date.now()-Date.parse(intent.entry_recovery_last_checked_at??'')<60000)return arm;
  if(intent.fill_checked) {
    const price=Number(intent.fill_price),at=Date.parse(intent.filled_at??''),original=Date.parse(intent.created_at??'');
    const args=validateEntryIntent(intent,arm);
    if(intent.order_id&&Number.isFinite(price)&&price>0&&price<=Number(args.price)&&Number.isFinite(at)&&
       at>=original-5000&&at<=Date.now()+5000) {
      const updated={...arm,entry_premium:price,opened_at:new Date(at).toISOString(),entry_fill_verified:true,
        entry_basis_verified:true,entry_basis_source:'broker_order_fill',entry_recovery_status:'entry_filled'};
      if(arm.entry_premium!==price||arm.opened_at!==updated.opened_at)appendJournal(root,'entry_fill_state_reconciled',{
        trade_id:arm.trade_id,option_id:arm.option_id,order_id:intent.order_id,premium:price,filled_at:updated.opened_at});
      atomic('arm.json',updated);
      return updated;
    }
  }
  const recovered=await recoveredEntry(client,account,arm);
  if(!recovered.fill)throw new Error('Original opening fill cannot yet be verified');
  const fill=recovered.fill;
  const updated={...arm,trade_id:arm.trade_id??intent.ref_id,entry_premium:fill.premium,opened_at:fill.filled_at,
    entry_fill_verified:true,entry_basis_verified:true,entry_basis_source:'broker_order_fill',entry_recovery_status:'entry_filled'};
  appendJournal(root,'entry_filled',{trade_id:updated.trade_id,option_id:arm.option_id,order_id:fill.order_id,
    filled_at:fill.filled_at,premium:fill.premium,executions:fill.executions,fees:fill.fees,
    recovered_order_id:Boolean(json('entry-intent.json')?.recovered_at)});
  atomic('arm.json',updated);atomic('entry-intent.json',{...json('entry-intent.json'),fill_checked:true,fill_price:fill.premium,filled_at:fill.filled_at});
  return updated;
}
function positionBasisArm(position,arm) {
  const intent=json('entry-intent.json');
  const basis=verifiedPositionEntryBasis(position,intent,arm);
  const previous=arm.entry_basis_verified&&arm.entry_basis_source==='broker_position_cost';
  const updated={...arm,entry_premium:basis.premium,opened_at:basis.opened_at,entry_basis_verified:true,
    entry_fill_verified:false,entry_basis_source:basis.basis,entry_recovery_status:'entry_outcome_unknown'};
  if(!previous||arm.entry_premium!==basis.premium||arm.opened_at!==basis.opened_at)appendJournal(root,'entry_cost_basis_recovered',{
    trade_id:arm.trade_id,option_id:arm.option_id,...basis,policy_snapshot:intent?.policy_snapshot??null});
  atomic('arm.json',updated);atomic('entry-intent.json',{...intent,entry_basis_verified:true,
    entry_basis_source:basis.basis,entry_basis_price:basis.premium,entry_basis_opened_at:basis.opened_at});
  return updated;
}
async function verifiedClosure(client, account, arm) {
  const entry=json('entry-intent.json');const openedAt=arm.opened_at??entry?.filled_at??entry?.created_at;
  if(!openedAt)return null;
  const ids=[json('exit-intent.json')?.order_id,json('stop-intent.json')?.order_id].filter(Boolean);
  for(const id of new Set(ids)) {
    const proof=matchingClosingFill(await order(client,account,id),arm,openedAt);
    if(proof)return proof;
  }
  const recent=await paged(client,'get_option_orders',{account_number:account,
    chain_ids:'a95fe906-11f0-4699-bfc2-520dd706e98d',created_at_gte:openedAt},'orders');
  for(const current of recent) {const proof=matchingClosingFill(current,arm,openedAt);if(proof)return proof;}
  return null;
}
function recordObservation(arm, decision, option, position, session) {
  if(!option)return;
  const age=Date.now()-Date.parse(option.updated_at??'');const bid=Number(option.bid_price),ask=Number(option.ask_price);
  if(!Number.isFinite(age)||age< -5000||age>10000||!Number.isFinite(bid)||!Number.isFinite(ask)||bid<0||ask<bid)return;
  const previous=json('trade-stats.json');
  const current=previous?.trade_id===arm.trade_id?previous:{trade_id:arm.trade_id,option_id:arm.option_id,
    observations:0,max_bid:bid,min_bid:bid};
  const updated={...current,observations:current.observations+1,max_bid:Math.max(current.max_bid,bid),
    min_bid:Math.min(current.min_bid,bid),last_at:new Date().toISOString(),
    observed_mfe_dollars:(Math.max(current.max_bid,bid)-arm.entry_premium)*100,
    observed_mae_dollars:(Math.min(current.min_bid,bid)-arm.entry_premium)*100};
  atomic('trade-stats.json',updated);
  appendJournal(root,'price_observation',{trade_id:arm.trade_id,option_id:arm.option_id,
    qqq_price:decision.qqq_price,qqq_quote_at:decision.observed_at,qqq_exit_level:decision.qqq_exit_level,
    option_bid:bid,option_ask:ask,option_quote_at:option.updated_at,...updated,
    ...researchTradeSample({arm,position,option,session,decision})});
}
async function exitPosition(client, account, arm, decision) {
  const result=await submitExit({arm,decision,intentStore:{load:()=>json('exit-intent.json'),save:v=>atomic('exit-intent.json',v)},broker:{
    orders:id=>ordersFor(client,account,id),order:id=>order(client,account,id),
    position:()=>positionFor(client,account,arm),
    cancel:id=>call(client,'cancel_option_order',{account_number:account,order_id:id},
      {beforeSend:ownershipDispatchGuard(account,arm)}),
    optionQuote:async id=>(await call(client,'get_option_quotes',{instrument_ids:[id]})).results?.find(x=>x?.quote?.instrument_id===id)?.quote,
    place:args=>call(client,'place_option_order',{account_number:account,
      legs:[{option_id:args.option_id,side:'sell',position_effect:'close'}],quantity:'1',type:args.type,
      ...(args.price?{price:args.price}:{}),time_in_force:'gfd',market_hours:'regular_hours',ref_id:args.ref_id},
      {beforeSend:ownershipDispatchGuard(account,arm,{place:true})}),
  }});
  health(result.status,{reason:decision.reason,...result});
  log(result.status,{reason:decision.reason,...result});
  appendJournal(root,'exit_action',{trade_id:arm.trade_id,option_id:arm.option_id,reason:decision.reason,...result});
}
async function premiumProtection(client,account,arm,option){
 const readOption=optionQuoteReader(option,async()=>(await call(client,'get_option_quotes',{instrument_ids:[arm.option_id]})).results?.find(x=>x?.quote?.instrument_id===arm.option_id)?.quote);
 return live?ensureStop({arm,entryFillVerified:arm.entry_basis_verified===true,
  intentStore:{load:()=>json('stop-intent.json'),save:v=>atomic('stop-intent.json',v)},broker:{
  orders:id=>ordersFor(client,account,id),order:id=>order(client,account,id),
  cancel:id=>call(client,'cancel_option_order',{account_number:account,order_id:id},
   {beforeSend:ownershipDispatchGuard(account,arm)}),
  optionQuote:()=>readOption(),
  placeStop:(args,options={})=>call(client,'place_option_order',{account_number:account,
   legs:[{option_id:args.option_id,side:'sell',position_effect:'close'}],quantity:'1',type:'stop_market',
   stop_price:args.stop_price,time_in_force:'gfd',market_hours:'regular_hours',ref_id:args.ref_id},
   {beforeSend:ownershipDispatchGuard(account,arm,{place:true,stop:true,beforeSend:options.beforeSend})}),
 }}):{status:'dry_run'};
}
async function run() {
  const release=acquireProcessLock(path('monitor.lock'));
  process.once('exit',release);
  process.once('SIGTERM',()=>process.exit(0));process.once('SIGINT',()=>process.exit(0));
  let client;
  try {
    health('starting');client=await connectReadOnly();
    const accounts=await call(client,'get_accounts',{});
    const allowed=(accounts.accounts??[]).filter(a=>a?.agentic_allowed&&a.state==='active');
    requireConfiguredAccount(allowed);
    const account=allowed[0].account_number;
    let errors=0;
    do {
      const start=Date.now();
      try {
        const raw=json('arm.json');
        if(!raw) {
          const all=await positions(client,account);
          const qqq=all.filter(p=>p.chain_symbol==='QQQ'&&Number(p.quantity)!==0);
          health(qqq.length?'unarmed_qqq_position':'idle');
        } else {
          let arm=validateArm(raw);
          const position=await positionFor(client,account,arm);
          if(!position) {
            // A close can be visible before the position/fill observations. Do
            // not calculate realized returns from the original limit estimate.
            if(!arm.entry_basis_verified&&json('entry-intent.json')?.order_id) {
              try{arm=await filledArm(client,account,arm);}catch{}
            }
            const proof=await verifiedClosure(client,account,arm);
            if(proof&&!arm.entry_basis_verified) {
              health('entry_fill_unverified',{closure_verified:true,entry_basis_verified:false,
                message:'Closing fill is verified; entry basis and realized P&L remain unverified'});
            } else if(proof) {
              const stats=json('trade-stats.json');const intent=json('exit-intent.json');
              appendJournal(root,'trade_closed',{trade_id:arm.trade_id??json('entry-intent.json')?.ref_id,
                option_id:arm.option_id,...proof,realized_pnl:proof.gross_realized_pnl,
                pnl_basis:arm.entry_basis_source==='broker_position_cost'?'broker_position_cost_unknown_fees':'fill_premiums_gross',
                entry_basis_source:arm.entry_basis_source,entry_fill_verified:arm.entry_fill_verified===true,
                reason:intent?.reason??'broker_stop_or_external_close',stats,entry_premium:arm.entry_premium});
              log('closure_verified',{option_id:arm.option_id,order_id:proof.order_id,gross_realized_pnl:proof.gross_realized_pnl});
              atomic('last-exit.json',verifiedExitContext({arm:{...arm,trade_id:arm.trade_id??json('entry-intent.json')?.ref_id},
                proof,reason:intent?.reason??'broker_stop_or_external_close'}));
              archiveClosed();health('closed',{closure_verified:true});
            } else if(json('stop-intent.json')||json('exit-intent.json')||arm.opened_at||json('entry-intent.json')?.fill_checked) {
              health('missing_position_unverified',{message:'Monitoring state retained until a closing fill is verified'});
            } else health(await awaitEntry(client,account,arm));
          } else {
            const initialTime=new Date(),initialExpiration=expirationStatus(arm.expiration_date,initialTime),initialPending=json('exit-intent.json');
            const urgent=arm.entry_fill_verified===true?{priority_exit:false}:await priorityEntryExit({
              readPrimaryDecision:async()=>{
                const pendingMatches=initialPending?.option_id===arm.option_id&&(!arm.trade_id||!initialPending.trade_id||initialPending.trade_id===arm.trade_id);
                const quote=initialExpiration.cutoff_reached||initialExpiration.window_missed||pendingMatches?null:
                  await call(client,'get_equity_quotes',{symbols:['QQQ']});
                return decideExit({arm,position,quote,pendingExit:initialPending,profitPlan:json('profit-plan.json')});
              },submitPrimaryExit:async decision=>{
                if(live)await exitPosition(client,account,arm,decision);
                else health('dry_run_exit',{reason:decision.reason});
              }});
            if(!urgent.priority_exit) {
            let entryBasisError;
            try{arm=await filledArm(client,account,arm);}
            catch(error){
              try{arm=positionBasisArm(position,arm);}
              catch(basisError){entryBasisError=String(basisError.message).slice(0,200);arm={...arm,entry_basis_verified:false,
                entry_fill_verified:false,entry_recovery_status:'entry_fill_unverified'};}
              log('entry_recovery_attention',{status:arm.entry_recovery_status,message:String(error.message).slice(0,200)});
            }
            const observedNow=new Date();const session=marketSession(observedNow);const expiration=expirationStatus(arm.expiration_date,observedNow);
            const pendingExit=json('exit-intent.json');const profitRequest=json('profit-exit-request.json');
            const isCutoff=expiration.cutoff_reached||expiration.window_missed;
            const pendingMatches=pendingExit?.option_id===arm.option_id&&(!arm.trade_id||!pendingExit.trade_id||pendingExit.trade_id===arm.trade_id);
            const profitMatches=arm.entry_basis_verified===true&&profitRequest?.option_id===arm.option_id&&(!arm.trade_id||profitRequest.trade_id===arm.trade_id);
            const skipQuote=isCutoff||pendingMatches||profitMatches;
            const review=await protectedDecision({readDecision:async()=>{
              const quote=skipQuote?null:await call(client,'get_equity_quotes',{symbols:['QQQ']});
              // Primary QQQ, pending and mandatory exits remain available even
              // while entry identity/basis needs attention. Unknown basis cannot
              // drive discretionary profit targets or a new entry-relative stop.
              return decideExit({arm,position,quote,pendingExit,
                profitRequest:arm.entry_basis_verified?profitRequest:null,
                profitPlan:arm.entry_basis_verified?json('profit-plan.json'):null});
            },ensureProtection:()=>premiumProtection(client,account,arm)});
            const decision=review.decision;
            if(decision.exit) {
              if(live)await exitPosition(client,account,arm,decision);
              else health('dry_run_exit',{reason:decision.reason});
            } else {
              let option;
              if(session.is_open) {
                try {option=(await call(client,'get_option_quotes',{instrument_ids:[arm.option_id]})).results?.find(x=>x?.quote?.instrument_id===arm.option_id)?.quote;recordObservation(arm,decision,option,position,session);}
                catch(e){log('observation_unavailable',{message:String(e.message).slice(0,200)});}
              }
              const protection=review.protection??await premiumProtection(client,account,arm,option);
              if(protection.ownership_status){const error=Error(protection.ownership_reason??protection.message??'Position ownership blocked');error.ownership_status=protection.ownership_status;error.ownership_reason=protection.ownership_reason;throw error;}
              let fast;
              const releaseState=acquireProcessLock(path('state.lock'));
              try{
                fast=evaluateProfitProtection({arm,position,plan:json('profit-protection-plan.json'),
                  state:json('profit-protection-state.json'),quote:option,session,now:Date.now()});
                if(fast.status!=='unavailable'&&fast.state)atomic('profit-protection-state.json',fast.state);
              }finally{releaseState();}
              if(protection.needs_exit)await exitPosition(client,account,arm,protection);
              else if(fast.exit_requested&&!['stop_filled_waiting_position','close_order_working'].includes(protection.status)){
                appendJournal(root,'profit_protection_triggered',{trade_id:arm.trade_id,option_id:arm.option_id,
                  floor_bid:fast.state.floor_bid,peak_bid:fast.state.peak_bid,quote_at:fast.observed_at,mode:fast.state.mode});
                await exitPosition(client,account,arm,{exit:true,reason:'profit_protection',observed_at:fast.observed_at});
              }else{
              health(expiration.window_missed?'expiration_window_missed':!expiration.verified?'calendar_unverified':entryBasisError?'entry_fill_unverified':decision.reason,
                {calendar_date:session.date,calendar_verified:session.verified,session_close_minute:session.close_minute,
                expiration_cutoff_minute:expiration.cutoff_minute,expiration_window_missed:expiration.window_missed,
                qqq_price:decision.qqq_price,quote_age_ms:decision.quote_age_ms,
                qqq_exit_level:decision.qqq_exit_level,stop_status:protection.status,stop_order_id:protection.order_id,
                stop_reject_reason:protection.reject_reason,data_error:review.data_error,
                entry_recovery_status:arm.entry_recovery_status,entry_basis_verified:arm.entry_basis_verified===true,
                entry_fill_verified:arm.entry_fill_verified===true,entry_basis_source:arm.entry_basis_source,
                entry_basis_error:entryBasisError,protection_readiness:protection.readiness,
                protection_phase:protection.protection_phase,protection_ready:protection.protection_ready,
                position_ownership_verified:true,broker_position_opened_at:arm.broker_position_opened_at,
                profit_protection_status:fast.status,profit_protection_reason:fast.reason,
                profit_protection_mode:fast.state?.mode??json('profit-protection-plan.json')?.mode??null,
                profit_floor_bid:fast.state?.floor_bid??null,profit_peak_bid:fast.state?.peak_bid??null});
              if(['stop_rejected','stop_pending','local_premium_watch_only'].includes(protection.status)) {
                log(protection.status,{option_id:arm.option_id,order_id:protection.order_id});
                appendJournal(root,'protection_status',{trade_id:arm.trade_id,option_id:arm.option_id,status:protection.status,order_id:protection.order_id});
              }
              }
            }
            }
          }
        }
        errors=0;
      } catch(e) {
        if(e.ownership_status){
          health(e.ownership_status,{position_ownership_verified:false,ownership_reason:e.ownership_reason??String(e.message).slice(0,200)});
          log(e.ownership_status,{reason:e.ownership_reason??String(e.message).slice(0,200)});errors=0;
        }else{
        const pending=json('exit-intent.json');const breach=Date.parse(pending?.breach_at??'');
        const accepted=Date.parse(pending?.first_accepted_submission_at??'');
        health('error',{message:String(e.message).slice(0,200),...(Number.isFinite(breach)?{breach_at:pending.breach_at,
          deadline_exceeded:(Number.isFinite(accepted)?accepted:Date.now())-breach>120000,
          deadline_met:Number.isFinite(accepted)?accepted-breach<=120000:null,
          elapsed_ms:(Number.isFinite(accepted)?accepted:Date.now())-breach}: {})});
        log('error',{message:String(e.message).slice(0,200)});
        if(++errors>=3)throw e;
        }
      }
      const interval=existsSync(path('arm.json'))?INTERVAL_MS:30000;
      if(!once)await new Promise(resolve=>setTimeout(resolve,Math.max(0,interval-(Date.now()-start))));
    } while(!once);
  } finally {if(client)await client.close();release();}
}
run().catch(e=>{process.stderr.write(`Monitor failed: ${String(e.message).slice(0,200)}\n`);process.exitCode=1;});
