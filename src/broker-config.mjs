/** Public distribution gates. These flags are operator consent, not a sandbox. */
export function assertBrokerEnabled(env = process.env) {
  if (env.QQQ_ENABLE_BROKER !== '1') throw new Error('Broker disabled: QQQ_ENABLE_BROKER must be 1');
}

export function configuredAccount(env = process.env) {
  const account = env.QQQ_ACCOUNT_NUMBER;
  if (typeof account !== 'string' || !account.trim() || account !== account.trim()) {
    throw new Error('Set an exact QQQ_ACCOUNT_NUMBER in the local environment');
  }
  return account;
}

export function requireConfiguredAccount(accounts, env = process.env) {
  const expected = configuredAccount(env);
  // Keep the original single-account invariant; never silently choose an account.
  if (!Array.isArray(accounts) || accounts.length !== 1 || accounts[0]?.account_number !== expected || !accounts[0]?.agentic_allowed) {
    throw new Error('Configured Agentic account is unavailable or ambiguous');
  }
  return accounts[0];
}

export function assertBrokerCall(name, args, env = process.env) {
  assertBrokerEnabled(env);
  if (typeof name !== 'string' || !name) throw new Error('Broker tool name is required');
  if (name.startsWith('get_')) return;
  if (env.QQQ_ENABLE_LIVE_ORDERS !== '1') throw new Error('Live orders disabled: QQQ_ENABLE_LIVE_ORDERS must be 1');
  if (!['place_option_order', 'cancel_option_order'].includes(name)) throw new Error('Broker mutation is not supported');
  if (args?.account_number !== configuredAccount(env)) throw new Error('Broker mutation account does not match configured account');
}
