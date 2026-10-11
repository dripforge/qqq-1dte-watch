import test from 'node:test';
import assert from 'node:assert/strict';
import {requireFreshReentry,recentExitContext,verifiedExitContext} from './reentry.mjs';
const id='00000000-0000-4000-8000-000000000001';
const exit={version:1,closure_verified:true,trade_id:id,option_id:id,closed_at:'2026-10-08T15:51:06Z',post_stop:true};
test('stopped setup cannot be recycled but a newly completed break can qualify',()=>{
 const now=Date.parse('2026-10-08T16:01:00Z');
 assert.throws(()=>requireFreshReentry(exit,{break_bar_at:'2026-10-08T15:45:00Z',confirm_bar_at:'2026-10-08T15:55:00Z',confirmation_1m_at:'2026-10-08T16:00:00Z'},now),/new break/);
 assert.equal(requireFreshReentry(exit,{break_bar_at:'2026-10-08T15:50:00Z',confirm_bar_at:'2026-10-08T15:55:00Z',confirmation_1m_at:'2026-10-08T16:00:00Z'},now).status,'fresh_setup_after_verified_exit');
});
test('prior session does not impose a new intraday delay and unverified closure cannot grant eligibility',()=>{
 assert.equal(requireFreshReentry(exit,{},Date.parse('2026-10-09T14:00:00Z')).status,'not_required');
 assert.throws(()=>recentExitContext({...exit,closure_verified:false},Date.parse('2026-10-08T16:00:00Z')),/unverified/);
 assert.throws(()=>verifiedExitContext({arm:{trade_id:id,option_id:id,option_type:'put'},proof:{closed_at:exit.closed_at},reason:'qqq_invalidation'}),/unavailable/);
});
