import { authorize, call, connectReadOnly } from './mcp.mjs';

const mode = process.argv[2] ?? 'check';
if (mode === 'auth') {
  const accounts = await authorize();
  for (const account of accounts) {
    process.stdout.write(`Agentic account ending ${account.account_number.slice(-4)} (${account.nickname ?? 'unnamed'})\n`);
  }
} else if (mode === 'check') {
  const client = await connectReadOnly();
  try {
    const accounts = await call(client, 'get_accounts', {});
    for (const account of accounts.accounts?.filter(a => a?.agentic_allowed) ?? []) {
      const portfolio = await call(client, 'get_portfolio', { account_number: account.account_number });
      process.stdout.write(`Agentic account ending ${account.account_number.slice(-4)}: $${portfolio.buying_power?.buying_power ?? 'unknown'} buying power\n`);
    }
  } finally { await client.close(); }
} else { throw new Error('Use auth or check'); }
