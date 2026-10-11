import { assertBrokerEnabled, assertBrokerCall } from './broker-config.mjs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { withBrokerAccess } from './broker-access.mjs';

const MCP_URL = new URL('https://agent.robinhood.com/mcp/trading');
const CALLBACK_URL = 'http://127.0.0.1:8765/callback';

function keychainRead() {
  const result = spawnSync(new URL('./keychain', import.meta.url).pathname, ['get'], { encoding: 'utf8' });
  if (result.status === 2) return {};
  if (result.status !== 0) throw new Error('Could not read Robinhood credentials from Keychain');
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('Saved Robinhood credentials are unreadable'); }
}

function keychainWrite(value) {
  const secret = JSON.stringify(value);
  const result = spawnSync(new URL('./keychain', import.meta.url).pathname, ['put'],
    { input: secret, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error('Could not save Robinhood credentials in Keychain');
}

class KeychainOAuthProvider {
  constructor() { this.saved = keychainRead(); }
  update(mutator) {
    const fresh=keychainRead();mutator(fresh);keychainWrite(fresh);this.saved=fresh;
  }
  get redirectUrl() { return CALLBACK_URL; }
  get clientMetadata() {
    return { client_name: 'QQQ 1DTE Watch', application_type: 'native',
      redirect_uris: [CALLBACK_URL] };
  }
  clientInformation(ctx) { this.saved=keychainRead();return ctx ? this.saved.clients?.[ctx.issuer] : undefined; }
  saveClientInformation(info, ctx) {
    if (!ctx) throw new Error('OAuth issuer missing');
    this.update(value=>{value.clients??={};value.clients[ctx.issuer]=info;});
  }
  tokens() { this.saved=keychainRead();return this.saved.tokens; }
  saveTokens(tokens) { this.update(value=>{value.tokens=tokens;}); }
  state() {
    this.update(value=>{value.state=crypto.randomUUID();});
    return this.saved.state;
  }
  saveDiscoveryState(discovery) {
    this.update(value=>{value.discovery=discovery;});
  }
  discoveryState() { this.saved=keychainRead();return this.saved.discovery; }
  redirectToAuthorization(url) { this.authorizationUrl = url.toString(); }
  saveCodeVerifier(verifier) { this.update(value=>{value.verifier=verifier;}); }
  codeVerifier() {
    this.saved=keychainRead();if (!this.saved.verifier) throw new Error('OAuth code verifier missing');
    return this.saved.verifier;
  }
}

function transport(provider) {
  return new StreamableHTTPClientTransport(MCP_URL, { authProvider: provider });
}

export async function connectReadOnly({timeoutMs=15000,lockTimeoutMs=12000,beforeConnect}={}) {
  assertBrokerEnabled();
  const provider = new KeychainOAuthProvider();
  const client = new Client({ name: 'qqq-1dte-watch', version: '0.1.0' });
  await withBrokerAccess(async()=>{await beforeConnect?.();return client.connect(transport(provider), { timeout: timeoutMs });},{timeoutMs:lockTimeoutMs});
  return client;
}

export async function authorize() {
  assertBrokerEnabled();
  const provider = new KeychainOAuthProvider();
  const client = new Client({ name: 'qqq-1dte-watch', version: '0.1.0' });
  let callbackResolve, callbackReject;
  const callback = new Promise((resolve, reject) => {
    callbackResolve = resolve; callbackReject = reject;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, CALLBACK_URL);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== provider.saved.state) {
      res.writeHead(400).end('Authorization state mismatch');
      callbackReject(new Error('Authorization state mismatch'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Authorization received. You can close this tab.');
    callbackResolve(url.searchParams);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(8765, '127.0.0.1', resolve);
  });
  try {
    const firstTransport = transport(provider);
    try { await client.connect(firstTransport); }
    catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      if (!provider.authorizationUrl) throw new Error('Broker did not provide an authorization URL');
      process.stdout.write(`Open this Robinhood authorization page:\n${provider.authorizationUrl}\n`);
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Authorization timed out')), 180000);
      });
      let params;
      try { params = await Promise.race([callback, timeout]); }
      finally { clearTimeout(timer); }
      await firstTransport.finishAuth(params);
      await client.connect(transport(provider));
    }
    const accounts = await call(client, 'get_accounts', {});
    const accessible = accounts.accounts?.filter(a => a?.agentic_allowed) ?? [];
    process.stdout.write(`Connected. Accessible Agentic accounts: ${accessible.length}.\n`);
    return accessible.map(a => ({ account_number: a.account_number, nickname: a.nickname }));
  } finally {
    server.close();
    await client.close();
  }
}

function parsedToolResult(result,name) {
  if (result.isError) {
    const detail = result.content?.filter(x => x.type === 'text').map(x => x.text).join(' ') || name;
    throw new Error(`Robinhood ${name} failed: ${detail}`);
  }
  if (result.structuredContent?.data) return result.structuredContent.data;
  const text = result.content?.find(x => x.type === 'text')?.text;
  if (!text) throw new Error(`Robinhood ${name} returned no data`);
  const parsed = JSON.parse(text);
  return parsed.data ?? parsed;
}
export async function call(client, name, args, { beforeSend,timeoutMs=10000,maxTotalTimeoutMs=12000,lockTimeoutMs=12000 } = {}) {
  assertBrokerCall(name, args);
  const execute=async(readName,readArgs,options={})=>parsedToolResult(await client.callTool({name:readName,arguments:readArgs},
    {timeout:options.timeoutMs??timeoutMs,maxTotalTimeout:options.maxTotalTimeoutMs??maxTotalTimeoutMs}),readName);
  return withBrokerAccess(async()=>{
    // A dispatch guard may verify position ownership under this same lock. This
    // reader cannot mutate broker state or recursively acquire the OAuth lock.
    const read=async(readName,readArgs,options)=>{
      if(!readName.startsWith('get_'))throw new Error('Dispatch verification permits read tools only');
      return execute(readName,readArgs,options);
    };
    await beforeSend?.({read});
    return execute(name,args);
  },{timeoutMs:lockTimeoutMs});
}
