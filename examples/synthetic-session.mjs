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

export function syntheticChecks(version) {
  return ['incomplete_structure','flat_follow_through','insufficient_risk','offline_boundary'].map((name,i)=>{
    const offset=(i-3)*300000,setup=syntheticSetup();
    setup.now=new Date(DEMO_NOW+offset);
    for(const bars of [setup.fiveMinuteBars,setup.oneMinuteBars])for(const row of bars)row.begins_at=stamp(Date.parse(row.begins_at)+offset);
    const candidate={version:1,direction:'call',pattern:'break_retest',level:500,
      break_bar_at:setup.fiveMinuteBars[1].begins_at,confirm_bar_at:setup.fiveMinuteBars[2].begins_at,
      confirmation_1m_at:setup.oneMinuteBars.at(-1).begins_at,rationale:'Invented completed breakout and retest for offline evaluation.'};
    if(name==='incomplete_structure')setup.fiveMinuteBars.pop();
    if(name==='flat_follow_through')setup.oneMinuteBars.at(-1).close_price=setup.oneMinuteBars.at(-1).open_price;
    const equity=name==='insufficient_risk'?500:10000,id='11111111-1111-4111-8111-111111111111',at=setup.now.toISOString();
    return {...setup,synthetic:true,name,candidate,
      health:{at,version,status:'idle',live:true},positions:{positions:[],next:null},orders:[],
      chain:{id:'synthetic-chain',symbol:'QQQ',can_open_position:true,trade_value_multiplier:100,expiration_dates:['2026-10-09']},
      instrument:{id,chain_id:'synthetic-chain',type:'call',expiration_date:'2026-10-09',state:'active',tradability:'tradable',strike_price:500},
      option:{instrument_id:id,updated_at:at,bid_price:1.95,ask_price:2,bid_size:10,ask_size:10},
      portfolio:{total_value:equity,buying_power:{buying_power:equity,unleveraged_buying_power:equity}},realized:{total_returns:0,data_points:[]}};
  });
}
