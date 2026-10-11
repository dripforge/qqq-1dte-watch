import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHeartbeatSecret, heartbeatSignal, sendExternalHeartbeat} from './external-heartbeat.mjs';
const secret = {version: 1, ping_url: 'https://hc-ping.com/12345678-1234-1234-1234-123456789012'};
test('secrets accept only the provider endpoint; redirects/private addresses and extensions fail', () => {
  assert.deepEqual(validateHeartbeatSecret(secret), secret);
  for (const url of ['http://hc-ping.com/12345678-1234-1234-1234-123456789012', 'https://127.0.0.1/x', secret.ping_url + '/fail', secret.ping_url + '?x=1', secret.ping_url + '#x']) assert.throws(() => validateHeartbeatSecret({...secret,ping_url:url}));
  assert.throws(() => validateHeartbeatSecret({...secret, account: 'private'}));
});
test('unverified monitoring or any outstanding issue never sends success', () => {
  assert.equal(heartbeatSignal({health:{live_verified:true},issues:[]}), 'success');
  assert.equal(heartbeatSignal({health:{live_verified:false},issues:[]}), 'failure');
  assert.equal(heartbeatSignal({health:{live_verified:true},issues:[{code:'entry_unknown'}]}), 'failure');
});
test('missing connection/dry run do not make requests or claim delivery', async () => {
  const fetcher = () => {throw Error('should not call');};
  assert.equal((await sendExternalHeartbeat({secret:null,live:true,signal:'success',fetcher})).status,'not_connected');
  assert.equal((await sendExternalHeartbeat({secret,live:false,signal:'success',fetcher})).status,'dry_run');
});
test('provider sends only minimal health data and failure suffix; acceptance is not phone delivery', async () => {
  let sent;
  const result = await sendExternalHeartbeat({secret,live:true,signal:'failure',fetcher:async (url,args)=>{sent={url,args};return {status:200};}});
  assert.equal(sent.url,secret.ping_url+'/fail');
  assert.equal(sent.args.body,'QQQ monitor failure');
  assert.equal(sent.args.redirect,'error');
  assert.equal(result.status,'signal_accepted');
  assert.equal(result.phone_delivery_verified,false);
  assert(!JSON.stringify(result).includes(secret.ping_url));
});
test('network/rejection failures remain visible without leaking endpoint', async () => {
  assert.equal((await sendExternalHeartbeat({secret,signal:'success',live:true,fetcher:async()=>{throw Error(secret.ping_url);}})).status,'signal_failed');
  assert.equal((await sendExternalHeartbeat({secret,signal:'success',live:true,fetcher:async()=>({status:302})})).status,'signal_rejected');
});
test('Kuma push URLs are normalized; status cannot be fixed to up by saved query parameters', async () => {
  const kuma = {version:1,ping_url:'http://192.168.1.2:3001/api/push/abcdefgh1234?status=up&msg=OK&ping='};
  assert.equal(validateHeartbeatSecret(kuma).ping_url,'http://192.168.1.2:3001/api/push/abcdefgh1234');
  let sent;
  const result = await sendExternalHeartbeat({secret:kuma,live:true,signal:'failure',fetcher:async(url,args)=>{sent={url,args};return {status:200,json:async()=>({ok:true})};}});
  assert.equal(new URL(sent.url).searchParams.get('status'),'down');
  assert.equal(new URL(sent.url).searchParams.get('msg'),'QQQ monitor failure');
  assert.equal(sent.args.method,'GET');
  assert.equal(result.status,'signal_accepted');
  assert.throws(()=>validateHeartbeatSecret({...kuma,ping_url:kuma.ping_url+'&arbitrary=1'}));
});
test('Kuma requires successful JSON acknowledgement, not merely HTTP 200', async () => {
  const kuma={version:1,ping_url:'https://monitor.example.com/api/push/abcdefgh1234'};
  for (const body of [{ok:false},{}]) assert.equal((await sendExternalHeartbeat({secret:kuma,signal:'success',live:true,fetcher:async()=>({status:200,json:async()=>body})})).status,'signal_rejected');
});
