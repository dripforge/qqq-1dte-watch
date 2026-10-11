import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEntryWatchPlan,validateEntryWatchPlan,assessEntryWatchPlan,claimEntryWatchPlan,buildEntryDispatch,
  readEntryWatchPlan,readEntryWatchState} from './entry-watch-plan.mjs';
import {validateEntryWatchClaim,entryAttemptPrevious,assertDirectEntryPlanClear,refreshClaimedEntryEvidence} from './entry-watch-plan.mjs';
import {validateSetup} from './setup-policy.mjs';

const NOW=Date.parse('2026-10-09T14:15:02Z'),stamp=value=>new Date(value).toISOString();
const ID='00000000-0000-4000-8000-000000000001',PLAN='00000000-0000-4000-8000-000000000002',ATTEMPT='00000000-0000-4000-8000-000000000003';
const policy={schema_version:1,policy_id:'qqq-1dte-risk',revision:2,sha256:'a'.repeat(64)};
const bar=(time,o,h,l,c)=>({begins_at:time,open_price:String(o),high_price:String(h),low_price:String(l),close_price:String(c),interpolated:false,session:'reg'});
function five(){return [bar('2026-10-09T13:55:00.000Z',99,100,98,99),bar('2026-10-09T14:00:00.000Z',99,101,99,100.5),
  bar('2026-10-09T14:05:00.000Z',100.5,101.5,100.2,101),bar('2026-10-09T14:10:00.000Z',101,101.6,100.7,101.2)];}
function minutes(){const bars=Array.from({length:10},(_,i)=>bar(stamp(NOW-602000+i*60000),101,101.4,100.8,101.1));
  bars[9]=bar(bars[9].begins_at,101.1,101.4,101,101.3);return bars;}
function input(){return {version:1,option_id:ID,direction:'call',expiration:'2026-10-12',qqq_invalidation:100.6,
  setup:{version:1,direction:'call',pattern:'break_hold',break_bar_at:'2026-10-09T14:00:00.000Z',confirm_bar_at:'2026-10-09T14:05:00.000Z',level:100,rationale:'Completed breakout stayed above the original reference'},
  profit_protection:{version:1,mode:'trend',rationale:'Completed trend structure supports a wider retained-gain floor'}};}
const quote=()=>({symbol:'QQQ',state:'active',has_traded:true,last_trade_price:'101.3',venue_last_trade_time:stamp(NOW-1000)});
function plan(changes={}){return createEntryWatchPlan(input(),{fiveMinuteBars:five(),qqqQuote:quote(),policySnapshot:policy,now:NOW,planId:PLAN,...changes});}
function assess(changes={}){return assessEntryWatchPlan({plan:plan(),policySnapshot:policy,now:NOW,
  health:{at:stamp(NOW),version:'2.3.2',status:'idle',live:true},localState:{trade_state_present:false,entry_busy:false},
  qqqQuote:quote(),fiveMinuteBars:five(),oneMinuteBars:minutes(),...changes});}

test('only completed verified structure creates a fixed short-lived explicit plan',()=>{
  const p=plan();assert.equal(Date.parse(p.expires_at)-Date.parse(p.created_at),180000);
  assert.equal(p.option_id,ID);assert.equal(p.qqq_invalidation,100.6);assert.equal(p.profit_protection.mode,'trend');
  assert.equal(p.setup.confirmation_1m_at,undefined);assert.equal(validateEntryWatchPlan(p,{policySnapshot:policy,now:NOW}),p);
  assert.throws(()=>plan({ttlMs:180001}),/lifetime/);
  const unfinished=five();unfinished[2].begins_at='2026-10-09T14:15:00.000Z';
  assert.throws(()=>plan({fiveMinuteBars:unfinished}));
  const candidate=input();candidate.profit_protection=undefined;
  assert.throws(()=>createEntryWatchPlan(candidate,{fiveMinuteBars:five(),qqqQuote:quote(),policySnapshot:policy,now:NOW}));
});

test('latest actual completed minute activates the original contract and mode without retargeting',()=>{
  const p=plan(),a=assess({plan:p});assert.equal(a.status,'ready');
  assert.equal(a.setup.confirmation_1m_at,minutes().at(-1).begins_at);
  const dispatch=buildEntryDispatch(p,a,{now:NOW});
  assert.deepEqual(dispatch.args,[ID,'call','2026-10-12','100.6']);
  assert.deepEqual(dispatch.setup.profit_protection,p.profit_protection);
  assert.equal(a.setup.setup_id.length,64);
});

test('non-directional follow-through waits; malformed/stale bars never count as a pending valid signal',()=>{
  const pending=minutes();pending[9]=bar(pending[9].begins_at,101.1,101.2,100.7,100.8);
  assert.equal(assess({oneMinuteBars:pending}).status,'waiting');
  const invalid=minutes();invalid[9].interpolated=true;
  assert.equal(assess({oneMinuteBars:invalid}).status,'blocked');
  assert.equal(assess({oneMinuteBars:[]}).status,'blocked');
  assert.equal(assess({oneMinuteBars:minutes().map(b=>({...b,begins_at:stamp(Date.parse(b.begins_at)-180000)}))}).status,'blocked');
});

test('expired plans and changed approved policy block rather than extend or substitute',()=>{
  const p=plan();assert.equal(assess({plan:p,now:NOW+180000}).status,'expired');
  assert.equal(assess({policySnapshot:{...policy,sha256:'b'.repeat(64)}}).status,'blocked');
  assert.equal(assess({policySnapshot:null}).status,'blocked');
  assert.throws(()=>validateEntryWatchPlan({...p,expires_at:stamp(NOW+240000)},{now:NOW}));
  assert.throws(()=>validateEntryWatchPlan(p,{now:Date.parse('2026-10-12T14:15:02Z')}));
});

test('changed contract, original invalidation, profit plan or reference fails integrity',()=>{
  const p=plan();
  for(const changed of [{...p,option_id:ATTEMPT},{...p,qqq_invalidation:100.2},{...p,setup:{...p.setup,level:100.1}},
    {...p,profit_protection:{...p.profit_protection,mode:'scalp'}},{...p,policy_snapshot:{...policy,revision:3}}]){
    assert.equal(assess({plan:changed}).status,'blocked');
  }
  const a=assess({plan:p});a.setup.profit_protection.mode='scalp';
  assert.throws(()=>buildEntryDispatch(p,a,{now:NOW}),/immutable plan/);
});

test('manual positions, pending direct entries, unknown local state and unverified monitor win priority',()=>{
  for(const localState of [null,{}, {trade_state_present:true,entry_busy:false},{trade_state_present:false,entry_busy:true}])assert.equal(assess({localState}).status,'blocked');
  for(const health of [null,{at:stamp(NOW-61000),status:'idle',live:true},{at:stamp(NOW),status:'unarmed_qqq_position',live:true}])assert.equal(assess({health}).status,'blocked');
  assert.equal(assess({brokerSnapshot:{positions:[{chain_symbol:'QQQ',quantity:'1'}]}}).reason,'manual_or_other_qqq_position');
  for(const brokerSnapshot of [{},{positions:null},{positions:[],next:'more'},{positions:[null]},
    {positions:[{chain_symbol:'QQQ',quantity:''}]}])assert.equal(assess({brokerSnapshot}).status,'blocked');
});

test('authorized bearish break-and-hold uses actual falling follow-through without inventing a failed reclaim',()=>{
  const invert=b=>({...b,open_price:String(200-Number(b.open_price)),close_price:String(200-Number(b.close_price)),
    high_price:String(200-Number(b.low_price)),low_price:String(200-Number(b.high_price))});
  const candidate=input();candidate.direction='put';candidate.qqq_invalidation=99.4;candidate.setup.direction='put';
  const q={...quote(),last_trade_price:'98.7'},fiveMinuteBars=five().map(invert),oneMinuteBars=minutes().map(invert);
  const p=createEntryWatchPlan(candidate,{fiveMinuteBars,qqqQuote:q,policySnapshot:policy,now:NOW,planId:PLAN});
  const a=assess({plan:p,qqqQuote:q,fiveMinuteBars,oneMinuteBars});
  assert.equal(a.status,'ready');assert.equal(a.setup.pattern,'break_hold');
  assert.deepEqual(buildEntryDispatch(p,a,{now:NOW}).args,[ID,'put','2026-10-12','99.4']);
});

test('dispatch claim is consumed before spawn and can never retry after an interrupted or failed child',()=>{
  const p=plan(),a=assess({plan:p});
  const consumed=claimEntryWatchPlan(p,null,{assessment:a,now:NOW,attemptId:ATTEMPT});
  assert.equal(consumed.status,'dispatch_started');assert.equal(consumed.attempted_at,stamp(NOW));
  assert.equal(assess({plan:p,state:consumed}).status,'attempted');
  for(const status of ['dispatch_started','blocked','completed','spawn_failed','outcome_unknown']){
    assert.throws(()=>claimEntryWatchPlan(p,{...consumed,status},{assessment:a,now:NOW}),/already consumed/);
  }
  assert.throws(()=>claimEntryWatchPlan(p,null,{assessment:assess({health:null}),now:NOW}),/ready assessment/);
  assert.throws(()=>claimEntryWatchPlan(p,null,{assessment:a,now:NOW+10001}),/assessment expired/);
});

test('a replaced plan cannot inherit prior state and attempted breaks cannot be recycled with a new plan id',()=>{
  const p=plan(),consumed=claimEntryWatchPlan(p,null,{assessment:assess({plan:p}),now:NOW,attemptId:ATTEMPT});
  assert.equal(assess({plan:plan({planId:ATTEMPT}),state:consumed}).status,'blocked');
  const previous={setup_id:assess({plan:p}).setup.setup_id,break_bar_at:p.setup.break_bar_at};
  assert.throws(()=>plan({planId:ATTEMPT,previous}),/new completed break/);
  assert.equal(assess({previous}).status,'blocked');
});

test('new five-minute reversal, invalidation breach or stale quote blocks activation with no automatic widening',()=>{
  const reversed=five();reversed[3]=bar(reversed[3].begins_at,101,101.1,99,99.5);
  assert.equal(assess({fiveMinuteBars:reversed}).status,'blocked');
  for(const q of [{...quote(),last_trade_price:'99.8'},{...quote(),last_trade_price:'100.5'},
    {...quote(),venue_last_trade_time:stamp(NOW-10001)},{...quote(),has_traded:false}])assert.equal(assess({qqqQuote:q}).status,'blocked');
});

test('post-close timing requires newly completed structure and real fresh follow-through',()=>{
  const p=plan(),lastExit={version:1,closure_verified:true,trade_id:ATTEMPT,option_id:ID,closing_order_id:PLAN,
    direction:'call',closed_at:'2026-10-09T14:06:00.000Z',reason:'qqq_invalidation'};
  assert.throws(()=>plan({lastExit}),/new five-minute structure/);
  assert.equal(assess({plan:p,lastExit}).status,'blocked');
  const earlier={...lastExit,closed_at:'2026-10-09T14:01:00.000Z'};
  assert.equal(assess({lastExit:earlier}).status,'ready');
});

test('bounded disk reads retain consumed state and reject malformed identity without production writes',t=>{
  const folder=mkdtempSync(join(tmpdir(),'qqq-plan-test-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const p=plan(),claimed=claimEntryWatchPlan(p,null,{assessment:assess({plan:p}),now:NOW,attemptId:ATTEMPT});
  assert.equal(readEntryWatchPlan(folder,{now:NOW}),null);assert.equal(readEntryWatchState(folder,{plan:p}),null);
  writeFileSync(join(folder,'entry-watch-plan.json'),JSON.stringify(p));writeFileSync(join(folder,'entry-watch-state.json'),JSON.stringify(claimed));
  assert.equal(readEntryWatchPlan(folder,{now:NOW,policySnapshot:policy}).plan_id,p.plan_id);
  assert.equal(readEntryWatchState(folder,{plan:p}).status,'dispatch_started');
  writeFileSync(join(folder,'entry-watch-state.json'),JSON.stringify({...claimed,plan_id:ATTEMPT}));
  assert.throws(()=>readEntryWatchState(folder,{plan:p}),/identity/);
  writeFileSync(join(folder,'entry-watch-plan.json'),' '.repeat(65537));assert.throws(()=>readEntryWatchPlan(folder,{now:NOW}),/too large/);
});

test('entry child verifies exact claimed activation evidence, policy and immutable command values',()=>{
  const p=plan(),a=assess({plan:p}),state=claimEntryWatchPlan(p,null,{assessment:a,now:NOW,attemptId:ATTEMPT});
  const request={plan:p,state,planId:PLAN,optionId:ID,direction:'call',expiration:p.expiration,invalidation:100.6,
    candidate:a.setup,policySnapshot:policy,now:NOW};
  assert.equal(validateEntryWatchClaim(request).state.attempt_id,ATTEMPT);
  for(const changed of [{optionId:PLAN},{direction:'put'},{expiration:'2026-10-13'},{invalidation:100.5},
    {candidate:{...a.setup,confirmation_1m_at:stamp(Date.parse(a.setup.confirmation_1m_at)+60000)}},
    {candidate:{...a.setup,profit_protection:{...a.setup.profit_protection,mode:'scalp'}}},
    {state:{...state,status:'blocked'}},{state:null},{plan:null},{policySnapshot:null},{expectedAttemptId:PLAN},
    {now:NOW+180000}])assert.throws(()=>validateEntryWatchClaim({...request,...changed}));
});

test('pending fast plan explicitly blocks scheduled direct entry until cancelled or resolved',()=>{
  const p=plan(),prepared={version:1,plan_id:p.plan_id,plan_sha256:p.plan_sha256,status:'prepared',attempted_at:null,
    attempt_id:null,activation_evidence_sha256:null};
  assert.throws(()=>assertDirectEntryPlanClear({plan:p,state:prepared,now:NOW}),/cancel or resolve/);
  assert.throws(()=>assertDirectEntryPlanClear({plan:p,state:prepared,now:NOW+180000}),/cancel or resolve/);
  assert.throws(()=>assertDirectEntryPlanClear({plan:p,state:null,now:NOW}),/cancel or resolve/);
  const consumed=claimEntryWatchPlan(p,prepared,{assessment:assess({plan:p}),now:NOW,attemptId:ATTEMPT});
  assert.throws(()=>assertDirectEntryPlanClear({plan:p,state:consumed,now:NOW}),/cancel or resolve/);
  assert.doesNotThrow(()=>assertDirectEntryPlanClear({plan:p,state:{...consumed,status:'blocked'},now:NOW+180000}));
  assert.throws(()=>assertDirectEntryPlanClear({plan:null,state:consumed,now:NOW}),/requires review/);
  assert.doesNotThrow(()=>assertDirectEntryPlanClear({plan:null,state:null,now:NOW}));
});

test('all direct entries dedupe fast history; an own child skips only its exact persisted claim',()=>{
  const a=assess(),fast={version:1,plan_id:PLAN,setup_id:a.setup.setup_id,break_bar_at:a.setup.break_bar_at,attempted_at:stamp(NOW)},
    prior={setup_id:'b'.repeat(64),break_bar_at:'2026-10-09T13:50:00.000Z'};
  assert.equal(entryAttemptPrevious(prior,fast),fast);
  const own={ownPlanId:PLAN,ownSetupId:fast.setup_id,ownAttemptedAt:fast.attempted_at};
  assert.equal(entryAttemptPrevious(prior,fast,own),prior);
  const newer={...prior,break_bar_at:'2026-10-09T14:10:00.000Z'};
  assert.equal(entryAttemptPrevious(newer,fast,own),newer);
  assert.throws(()=>entryAttemptPrevious(prior,null,own),/own fast attempt/);
  assert.throws(()=>entryAttemptPrevious(prior,{...fast,plan_id:ATTEMPT},own),/own fast attempt/);
  assert.throws(()=>entryAttemptPrevious(prior,{...fast,attempted_at:stamp(NOW+1)},own),/own fast attempt/);
  assert.throws(()=>entryAttemptPrevious(prior,{...fast,setup_id:'malformed'}),/history invalid/);
});

test('verified child can refresh only the latest real minute while original file and claim stay fixed',()=>{
  const p=plan(),a=assess({plan:p}),state=claimEntryWatchPlan(p,null,{assessment:a,now:NOW,attemptId:ATTEMPT}),
    claim=validateEntryWatchClaim({plan:p,state,planId:PLAN,optionId:ID,direction:'call',expiration:p.expiration,invalidation:100.6,candidate:a.setup,policySnapshot:policy,now:NOW});
  const next=minutes().map(b=>({...b,begins_at:stamp(Date.parse(b.begins_at)+60000)}));
  const derived=refreshClaimedEntryEvidence(a.setup,claim,{oneMinuteBars:next,now:NOW+60000});
  assert.equal(a.setup.confirmation_1m_at,minutes().at(-1).begins_at);
  assert.equal(derived.confirmation_1m_at,next.at(-1).begins_at);
  for(const key of Object.keys(a.setup).filter(key=>key!=='confirmation_1m_at'))assert.deepEqual(derived[key],a.setup[key]);
  assert.doesNotThrow(()=>validateSetup(derived,{direction:'call',fiveMinuteBars:five(),oneMinuteBars:next,now:new Date(NOW+60000)}));
  const rejected=next.map(b=>({...b}));rejected[9]=bar(rejected[9].begins_at,101.1,101.2,100.7,100.8);
  const bad=refreshClaimedEntryEvidence(a.setup,claim,{oneMinuteBars:rejected,now:NOW+60000});
  assert.throws(()=>validateSetup(bad,{direction:'call',fiveMinuteBars:five(),oneMinuteBars:rejected,now:new Date(NOW+60000)}),/directional follow-through/);
  assert.throws(()=>refreshClaimedEntryEvidence({...a.setup,level:100.1},claim,{oneMinuteBars:next,now:NOW+60000}));
  assert.throws(()=>refreshClaimedEntryEvidence(a.setup,{...claim,state:{...state,status:'blocked'}},{oneMinuteBars:next,now:NOW+60000}));
  assert.throws(()=>refreshClaimedEntryEvidence(a.setup,claim,{oneMinuteBars:next,now:NOW+180000}));
  assert.throws(()=>refreshClaimedEntryEvidence(a.setup,claim,{oneMinuteBars:[],now:NOW+60000}));
});
