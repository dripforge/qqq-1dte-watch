// Invented prices, identities and decisions. No historical market capture.
export const DEMO_NOW = Date.parse('2026-10-08T16:01:10Z');
const stamp = ms => new Date(ms).toISOString();
const bar = (at, open, high, low, close) => ({begins_at:at,open_price:String(open),high_price:String(high),low_price:String(low),close_price:String(close),session:'reg',volume:1000,interpolated:false});

export function syntheticSetup() {
  const fiveMinuteBars=[
    bar('2026-10-08T15:45:00Z',499.8,499.95,499.7,499.8),
    bar('2026-10-08T15:50:00Z',499.8,500.6,499.75,500.5),
    bar('2026-10-08T15:55:00Z',500.5,500.8,499.95,500.7),
  ];
  const oneMinuteBars=Array.from({length:10},(_,i)=>{
    const close=500.2+i*.04;
    return bar(stamp(Date.parse('2026-10-08T15:51:00Z')+i*60000),close-.02,close+.1,close-.1,close);
  });
  return {fiveMinuteBars,oneMinuteBars,qqqPrice:500.56,now:new Date(DEMO_NOW),explicitReferences:[{
    direction:'call',level:500,established_at:'2026-10-08T15:45:00Z',rationale:'Synthetic reference established before the break.'
  }]};
}

export function syntheticResearch() {
  const origin=DEMO_NOW-10*60000, id='11111111-1111-4111-8111-111111111111';
  function item(name,offset,{gap=false,chase=false}={}) {
    const start=origin+offset;
    const samples=Array.from({length:13},(_,i)=>{
      const ask=i===0?2:chase?2.1+i*.01:i<=3?1.95:2+i*.01;
      return {quote_at:stamp(start+i*10000),observed_at:stamp(start+i*10000),bid:ask-.05,ask,bid_size:10,ask_size:10};
    }).filter((_,i)=>!gap||![1,2,3].includes(i));
    return {case_id:name,first_observed_at:stamp(start),last_observed_at:stamp(start+120000),direction:'call',first_event_kind:'setup',primary_instrument_id:id,
      setup_evidence:{reference_level:500+offset/60000,break_bar_at:stamp(start-600000)},
      bases:{case:{reference_observed_at:stamp(start),reference_contracts:{[id]:{ask:2,quote_usable:true}},scalp:{instruments:{[id]:{samples}}}}}};
  }
  return {version:1,recorded_events:3,created_cases:3,seen_event_ids:[],cases:{
    complete:item('synthetic-complete',0),gap:item('synthetic-gap',180000,{gap:true}),chase:item('synthetic-chase',360000,{chase:true})
  }};
}
