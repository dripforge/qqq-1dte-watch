import { connectReadOnly, call } from './mcp.mjs';

const client = await connectReadOnly();
const samples = [];
try {
  for (let i = 0; i < 8; i++) {
    const start = Date.now();
    const result = await call(client, 'get_equity_quotes', { symbols: ['QQQ'] });
    const end = Date.now();
    const quote = result.results?.[0]?.quote;
    samples.push({ latency_ms: end - start,
      quote_age_ms: end - Date.parse(quote?.venue_last_trade_time ?? ''),
      valid: quote?.state === 'active' && quote?.has_traded === true });
    if (i < 7) await new Promise(resolve => setTimeout(resolve, 5000));
  }
} finally { await client.close(); }
const numbers = key => samples.map(s => s[key]).sort((a, b) => a - b);
const latency = numbers('latency_ms'), age = numbers('quote_age_ms');
console.log(JSON.stringify({ samples: samples.length, all_valid: samples.every(s => s.valid),
  latency_ms: { median: latency[Math.floor(latency.length / 2)], max: latency.at(-1) },
  quote_age_ms: { median: age[Math.floor(age.length / 2)], max: age.at(-1) } }));
