import { requireConfiguredAccount } from './broker-config.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, connectReadOnly } from './mcp.mjs';
import { validateArm } from './logic.mjs';
import { marketSession, expirationStatus } from './session.mjs';
import { assessServiceHealth } from './service-health.mjs';
import { effectiveExitLevel, validateBufferedTrail, profitCushion } from './profit-policy.mjs';
import { completedBars } from './setup-policy.mjs';
import { appendJournal } from './journal.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { buildProfitResearchEvent, safeRecordResearchEvent } from './research-hooks.mjs';
import { createProfitProtectionPlan, validateProfitProtectionEvidence } from './profit-protection.mjs';
import { assertOwnedPositionSnapshot } from './position-ownership.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const path=name=>join(root,name);
const args=process.argv.slice(2),[action,arg,reason]=args;
const evidenceFlag=args.indexOf('--evidence-json');
const evidencePath=evidenceFlag>=0&&args[evidenceFlag+1]?resolve(args[evidenceFlag+1]):null;
const reasons=new Set(['momentum_reversal','trend_exhaustion','stalled_move','late_session','trend_intact']);
function json(name){return existsSync(path(name))?JSON.parse(readFileSync(path(name),'utf8')):null;}
function atomic(name,data){const tmp=`${path(name)}.${process.pid}.tmp`;writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});renameSync(tmp,path(name));}
function fresh(at,limit=10000){const age=Date.now()-Date.parse(at??'');return Number.isFinite(age)&&age>=-5000&&age<=limit;}
function fail(message){throw new Error(message);}
async function main(){
 if(!['hold','tighten','sell'].includes(action))fail('Use hold REASON, tighten LEVEL REASON, or sell REASON with --evidence-json PATH');
 const reasonCode=action==='tighten'?reason:arg;
 if(!reasons.has(reasonCode)||action==='sell'&&reasonCode==='trend_intact')fail('A suitable reason code is required');
 if(!evidencePath||!evidencePath.startsWith(root+sep))fail('Profit evidence file inside monitor folder required');
 const evidence=JSON.parse(readFileSync(evidencePath,'utf8'));
 if(evidence.version!==1||evidence.reason!==reasonCode||typeof evidence.rationale!=='string'||evidence.rationale.trim().length<12||evidence.rationale.length>2000)fail('Structured profit rationale required');
 if(evidence.profit_protection!==undefined)validateProfitProtectionEvidence(evidence.profit_protection);
 const arm=validateArm(json('arm.json'));
 if(json('exit-intent.json')||json('profit-exit-request.json'))fail('An exit is already requested');
 const health=json('health.json');
 if(!assessServiceHealth(health,{maxAgeMs:15000}).live_verified||health.status!=='holding')fail('Live monitor is not healthy and holding');
 const session=marketSession(new Date());
 if(!session.is_open||session.date>arm.expiration_date)fail('Profit management outside a verified regular market session');
 if(!expirationStatus(arm.expiration_date).verified)fail('Profit management requires a verified expiration session');
 if(expirationStatus(arm.expiration_date).cutoff_reached)fail('Expiration cutoff exit takes priority over discretionary profit management');
 const client=await connectReadOnly();
 let researchEvent;
 try{
  const accounts=await call(client,'get_accounts',{});
  const allowed=(accounts.accounts??[]).filter(a=>a?.agentic_allowed&&a.state==='active');
  requireConfiguredAccount(allowed);
  const account=allowed[0].account_number;
  const [positions,equity,options,minuteHistory,fiveHistory]=await Promise.all([
   call(client,'get_option_positions',{account_number:account,nonzero:true}),
   call(client,'get_equity_quotes',{symbols:['QQQ']}),
   call(client,'get_option_quotes',{instrument_ids:[arm.option_id]}),
   call(client,'get_equity_historicals',{symbols:['QQQ'],interval:'minute',start_time:new Date(Date.now()-20*60000).toISOString(),bounds:'regular'}),
   call(client,'get_equity_historicals',{symbols:['QQQ'],interval:'5minute',start_time:new Date(Date.now()-40*60000).toISOString(),bounds:'regular'}),
  ]);
  if(positions.next)fail('Cannot verify complete position state');
  assertOwnedPositionSnapshot({snapshot:positions,arm,intent:json('entry-intent.json')});
  const qqqPositions=(positions.positions??[]).filter(p=>p?.chain_symbol==='QQQ'&&Number(p.quantity)!==0);
  if(qqqPositions.length!==1||qqqPositions[0].option_id!==arm.option_id||qqqPositions[0].type!=='long'||Number(qqqPositions[0].quantity)!==1)fail('Matching one-contract position is not present');
  const qqq=equity.results?.find(x=>x?.quote?.symbol==='QQQ')?.quote;
  const price=Number(qqq?.last_trade_price);
  if(!qqq||qqq.state!=='active'||!qqq.has_traded||!fresh(qqq.venue_last_trade_time)||!Number.isFinite(price)||price<=0)fail('Fresh QQQ quote unavailable');
  const option=options.results?.find(x=>x?.quote?.instrument_id===arm.option_id)?.quote;
  if(!option||!fresh(option.updated_at))fail('Fresh option quote unavailable');
  const bars=completedBars(minuteHistory.results?.find(x=>x?.symbol==='QQQ')?.bars,60000);
  const five=completedBars(fiveHistory.results?.find(x=>x?.symbol==='QQQ')?.bars,300000,new Date(),{count:3,maxAgeMs:330000});
  if(five.at(-1).begins_at!==evidence.five_minute_at||bars.at(-1).begins_at!==evidence.one_minute_at)fail('Profit evidence must reference the latest completed broker bars');
  researchEvent=buildProfitResearchEvent({now:Date.now(),arm,qqq,option,oneMinuteBars:bars,fiveMinuteBars:five});
  const record={trade_id:arm.trade_id,option_id:arm.option_id,action,reason:reasonCode,evidence,
   qqq_price:price,option_quote:option,completed_1m_bars:bars,completed_5m_bars:five};
  if(action==='hold'&&evidence.profit_protection===undefined){
   appendJournal(root,'profit_decision',record);process.stdout.write(JSON.stringify({status:'hold_recorded',reason:reasonCode})+'\n');return;
  }
  if(arm.entry_basis_verified!==true)fail('Actual entry basis must be verified before a discretionary profit action');
  const cushion=action==='hold'?null:profitCushion(arm,option);
  const protectionPlan=evidence.profit_protection===undefined?null:createProfitProtectionPlan({arm,evidence:evidence.profit_protection});
  // Recheck local state after reads so a newly requested urgent exit wins.
  const releaseState=acquireProcessLock(path('state.lock'));
  try {
  if(json('exit-intent.json')||json('profit-exit-request.json'))fail('An exit became pending during profit review');
  const currentArm=json('arm.json'),currentHealth=json('health.json'),now=marketSession(new Date());
  if(currentArm?.option_id!==arm.option_id||currentArm?.trade_id!==arm.trade_id||currentArm?.broker_position_opened_at!==arm.broker_position_opened_at||!assessServiceHealth(currentHealth,{maxAgeMs:15000}).live_verified||currentHealth.status!=='holding')fail('Position or monitor state changed during profit review');
  if(!now.is_open||now.date>arm.expiration_date||expirationStatus(arm.expiration_date).cutoff_reached||!fresh(qqq.venue_last_trade_time)||!fresh(option.updated_at))fail('Profit prices or session changed during review');
  if(action==='hold'){
   atomic('profit-protection-plan.json',protectionPlan);
   appendJournal(root,'profit_decision',{...record,profit_protection:protectionPlan});
   process.stdout.write(JSON.stringify({status:'hold_recorded',reason:reasonCode,profit_protection_mode:protectionPlan.mode})+'\n');
  }else if(action==='tighten'){
   const previous=json('profit-plan.json');
   const trail=validateBufferedTrail(arm,previous,arg,price,bars);
   if(protectionPlan)atomic('profit-protection-plan.json',protectionPlan);
   atomic('profit-plan.json',{option_id:arm.option_id,trade_id:arm.trade_id,qqq_trailing_level:trail.level,reason:reasonCode,
    updated_at:new Date().toISOString(),qqq_price_at_update:price,option_bid_at_update:cushion.bid,swing:trail,evidence});
   appendJournal(root,'profit_decision',{...record,...trail,...cushion,profit_protection:protectionPlan});
   process.stdout.write(JSON.stringify({status:'profit_trail_tightened',previous_level:effectiveExitLevel(arm,previous),new_level:trail.level})+'\n');
  }else{
   if(protectionPlan)atomic('profit-protection-plan.json',protectionPlan);
   atomic('profit-exit-request.json',{request_id:randomUUID(),option_id:arm.option_id,trade_id:arm.trade_id,requested_at:new Date().toISOString(),
    reason:reasonCode,qqq_price_at_request:price,option_bid_at_request:cushion.bid,evidence});
   appendJournal(root,'profit_decision',{...record,...cushion});process.stdout.write(JSON.stringify({status:'profit_exit_queued',quoted_gross_profit:cushion.quoted_gross_profit})+'\n');
  }
  } finally {releaseState();}
 }finally{try{await client.close();}finally{if(researchEvent)safeRecordResearchEvent(researchEvent,{folder:root,now:Date.now()});}}
}
let release;
try{release=acquireProcessLock(path('profit.lock'));await main();}
catch(e){try{appendJournal(root,'profit_action_blocked',{action,reason:String(e.message).slice(0,300)});}catch{}process.stderr.write(`Profit action blocked: ${e.message}\n`);process.exitCode=1;}
finally{if(release)release();}
