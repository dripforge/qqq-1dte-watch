import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readServiceHealth } from './service-health.mjs';
import { loadApprovedRiskPolicy } from './approved-risk-policy.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { appendJournal } from './journal.mjs';
import { watchdogIssues, changedIssues } from './watchdog-policy.mjs';
import {loadHeartbeatSecret, heartbeatSignal, sendExternalHeartbeat, HEARTBEAT_INTERVAL_MS} from './external-heartbeat.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes('--live');
const once = process.argv.includes('--once');
const stateFiles = ['arm.json', 'entry-intent.json', 'exit-intent.json', 'profit-exit-request.json'];
const startedAt = Date.now();
function read(name) { const file = join(root, name); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }
function atomic(name, data) {
  const file = join(root, name), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600}); renameSync(tmp, file);
}
function quoted(text) { return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ')}"`; }
function notify(message) {
  if (!live) return { status: 'dry_run' };
  try {
    execFileSync('/usr/bin/osascript', ['-e', `display notification ${quoted(message)} with title "QQQ trading"`],
      { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 'notification_submitted' };
  } catch { return { status: 'notification_failed' }; }
}
const release = acquireProcessLock(join(root, 'watchdog.lock'));
try {
  let previous = [], notifications = {}, externalHeartbeat = {status:'not_connected',phone_delivery_verified:false};
  let secret, secretError = false, secretLoadedAt = 0, lastExternalAt = 0, lastExternalSignal;
  try {
    const prior = read('watchdog-status.json');
    if (prior?.live === live) { previous = prior.issues ?? []; notifications = prior.notifications ?? {}; }
  } catch {}
  do {
    const tick = Date.now();
    try {
      let watch, stateError = false, approved, policyError = false;
      try { watch = read('watch-status.json'); } catch { stateError = true; }
      const hasState = stateFiles.some(name => existsSync(join(root, name)));
      for (const name of stateFiles) { try { if (existsSync(join(root, name))) read(name); } catch { stateError = true; } }
      try { approved = loadApprovedRiskPolicy(root); } catch { policyError = true; }
      const health = readServiceHealth(root);
      let stopPendingAt;
      try { stopPendingAt = read('stop-intent.json')?.created_at; } catch { stateError = true; }
      let session;
      try { session = (await import('./session.mjs')).marketSession(new Date(tick)); }
      catch { session = {verified: false, is_open: false}; }
      const issues = watchdogIssues({health,
        watch, hasState, session, policyError, stateError, stopPendingAt, now: tick, startedAt});
      if (tick - secretLoadedAt >= 60000 || !secretLoadedAt) {
        try { secret = loadHeartbeatSecret(root); secretError = false; } catch { secret = null; secretError = true; externalHeartbeat = {status:'configuration_unavailable',phone_delivery_verified:false}; }
        secretLoadedAt = tick;
      }
      if(secretError) issues.push({code:'external_connection_unavailable',urgent:hasState,message:'QQQ external monitoring connection cannot be read. Review the trading task.'});
      const signal = heartbeatSignal({health,issues});
      if (tick - lastExternalAt >= HEARTBEAT_INTERVAL_MS || signal !== lastExternalSignal) {
        const delivery = await sendExternalHeartbeat({secret,signal,live});
        externalHeartbeat = {...delivery,connected:!!secret,at:new Date(tick).toISOString()};
        lastExternalAt = tick; lastExternalSignal = signal;
      }
      if (secret && ['signal_failed','signal_rejected'].includes(externalHeartbeat.status)) issues.push({code:'external_heartbeat_failed',urgent:hasState,message:'QQQ external monitoring cannot receive its heartbeat. Review the trading task.'});
      const change = changedIssues(previous, issues);
      const retry = issues.filter(issue => !change.added.some(added => added.code === issue.code) &&
        notifications[issue.code]?.status === 'notification_failed' && tick - notifications[issue.code].at >= 60000);
      for (const issue of [...change.added, ...retry]) {
        const delivery = notify(issue.message);
        notifications[issue.code] = {status: delivery.status, at: tick};
        appendJournal(root, 'watchdog_alert', {code: issue.code, urgent: issue.urgent, message: issue.message, delivery: delivery.status});
        process.stdout.write(JSON.stringify({at: new Date(tick).toISOString(), ...issue, delivery: delivery.status}) + '\n');
      }
      if (change.recovered.length && !issues.length) {
        const delivery = notify('QQQ monitoring checks have recovered. Review the task for any trade that needs attention.');
        appendJournal(root, 'watchdog_recovered', {codes: change.recovered.map(issue => issue.code), delivery: delivery.status});
      }
      atomic('watchdog-status.json', {at: new Date(tick).toISOString(), live, status: issues.length ? 'attention' : 'healthy',
        issues, notifications, service: health, policy_snapshot: approved?.snapshot ?? null, market_session: session,
        last_watch_at: watch?.observed_at ?? null, external_heartbeat:externalHeartbeat});
      previous = issues;
    } catch (error) {
      const issue = {code: 'watchdog_check_failed', urgent: true, message: 'QQQ watchdog could not complete its checks. Review the trading task.'};
      if (!previous.some(item => item.code === issue.code) ||
        notifications[issue.code]?.status === 'notification_failed' && tick - notifications[issue.code].at >= 60000) {
        const delivery = notify(issue.message);
        notifications[issue.code] = {status: delivery.status, at: tick};
        appendJournal(root, 'watchdog_alert', {...issue, delivery: delivery.status});
      }
      previous = [issue];
      const delivery = await sendExternalHeartbeat({secret,signal:'failure',live});
      externalHeartbeat = {...delivery,connected:!!secret,at:new Date(tick).toISOString()};
      atomic('watchdog-status.json', {at: new Date().toISOString(), live, status: 'error', issues: previous, notifications,
        message: String(error.message).slice(0, 250),external_heartbeat:externalHeartbeat});
    }
    if (!once) await new Promise(resolve => setTimeout(resolve, Math.max(0, 10000 - (Date.now() - tick))));
  } while (!once);
} finally { release(); }
