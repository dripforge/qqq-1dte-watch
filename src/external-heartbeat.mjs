import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const HEARTBEAT_INTERVAL_MS = 30000;
export function validateHeartbeatSecret(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'ping_url,version' || value.version !== 1) throw new Error('External heartbeat configuration is invalid');
  let url;
  try { url = new URL(value.ping_url); } catch { throw new Error('External heartbeat address is invalid'); }
  // The user supplies the endpoint; never discover or scan private hosts.
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('External heartbeat address is invalid');
  const healthchecks = url.protocol === 'https:' && url.hostname === 'hc-ping.com' && !url.port && !url.search &&
    /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(url.pathname);
  const kuma = /\/api\/push\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname) &&
    [...url.searchParams.keys()].every(key => ['status', 'msg', 'ping'].includes(key));
  if (!healthchecks && !kuma) throw new Error('A Healthchecks.io or Uptime Kuma push URL is required');
  url.search = '';
  return {version: 1, ping_url: url.href};
}

export function loadHeartbeatSecret(folder) {
  const executable = join(folder, 'external-keychain');
  const result = spawnSync(executable, ['get'], {encoding: 'utf8', timeout: 3000, maxBuffer: 4096});
  if (result.status === 2 || result.error?.code === 'ENOENT') return null;
  if (result.status !== 0) throw new Error('External heartbeat Keychain record is unavailable');
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('External heartbeat Keychain record is invalid'); }
  return validateHeartbeatSecret(value);
}

export function heartbeatSignal({health, issues}) {
  return health?.live_verified === true && !issues?.length ? 'success' : 'failure';
}

export async function sendExternalHeartbeat({secret, signal, live, fetcher = fetch, timeoutMs = 4000}) {
  if (!secret) return {status: 'not_connected', phone_delivery_verified: false};
  const checked = validateHeartbeatSecret(secret);
  if (!['success', 'failure'].includes(signal)) throw new Error('Invalid heartbeat signal');
  if (!live) return {status: 'dry_run', signal, phone_delivery_verified: false};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(checked.ping_url);
    const kuma = url.pathname.includes('/api/push/');
    if (kuma) { url.searchParams.set('status', signal === 'success' ? 'up' : 'down'); url.searchParams.set('msg', 'QQQ monitor ' + signal); }
    else if (signal === 'failure') url.pathname += '/fail';
    const response = await fetcher(url.href, {
      method: kuma ? 'GET' : 'POST', ...(kuma ? {} : {body: 'QQQ monitor ' + signal, headers: {'content-type': 'text/plain'}}),
      redirect: 'error', signal: controller.signal,
    });
    let accepted = response.status === 200;
    if (kuma && accepted) { try { accepted = (await response.json()).ok === true; } catch { accepted = false; } }
    return {status: accepted ? 'signal_accepted' : 'signal_rejected', signal,
      phone_delivery_verified: false};
  } catch { return {status: 'signal_failed', signal, phone_delivery_verified: false}; }
  finally { clearTimeout(timer); }
}
