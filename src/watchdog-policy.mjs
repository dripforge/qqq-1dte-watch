const attentionStatuses = new Set(['error', 'unarmed_qqq_position', 'missing_position_unverified',
  'entry_outcome_unknown', 'exit_outcome_unknown', 'stop_outcome_unknown', 'qqq_data_unavailable',
  'expiration_window_missed', 'calendar_unverified', 'entry_fill_unverified',
  'position_ownership_changed','position_ownership_unverified']);

export function watchdogIssues({ health, watch, hasState = false, session, policyError,
  stateError, stopPendingAt, now = Date.now(), startedAt = now, watchLimitMs = 120000 }) {
  const issues = [];
  const reported = health?.reported_status ?? health?.service_reported_status;
  const holding = hasState || (health?.fresh && reported === 'holding') ||
    !(health?.fresh && ['idle', 'closed'].includes(reported)) && Number(watch?.positions_open) > 0;
  if (!health?.live_verified) issues.push({ code: 'monitor_unverified', urgent: holding,
    message: `QQQ exit monitor needs attention: ${health?.condition ?? 'health unavailable'}${holding ? '; a trade may be open' : ''}.` });
  if (health?.fresh && attentionStatuses.has(reported)) issues.push({ code: `monitor_${reported}`, urgent: true,
    message: `QQQ exit monitor reports ${reported.replaceAll('_', ' ')}. Review the trading task.` });
  if (health?.fresh && holding && ['entry_outcome_unknown','entry_fill_unverified'].includes(health?.entry_recovery_status) && reported !== health.entry_recovery_status) issues.push({code:'entry_recovery_unverified',urgent:true,message:'QQQ entry order identity or actual entry basis needs attention. Existing position monitoring continues; new buys are blocked.'});
  if (health?.fresh && holding && session?.is_open && health?.protection_issues?.length) issues.push({code:'protection_readiness_failed',urgent:true,message:'QQQ opening or broker protection checks need attention. Review the trading task.'});
  if(health?.fresh&&holding&&session?.is_open&&reported==='holding'&&health?.profit_protection_status==='unavailable')issues.push({code:'profit_protection_unavailable',urgent:true,message:'QQQ local profit protection is unavailable. The original risk exit remains active; review the trading task.'});
  if (health?.fresh && health?.deadline_exceeded) issues.push({ code: 'exit_deadline_missed', urgent: true,
    message: 'QQQ exit order submission exceeded the two-minute target. Review the trading task.' });
  if (health?.fresh && health?.data_unavailable && reported !== 'qqq_data_unavailable') issues.push({code: 'primary_data_unavailable', urgent: holding,
    message: 'QQQ data needed for the primary invalidation exit is unavailable. Review the trading task.'});
  if (health?.fresh && holding && session?.is_open) {
    const stop = health.stop_status;
    const since = Date.parse(stopPendingAt ?? '');
    const pendingTooLong = stop === 'stop_pending' && Number.isFinite(since) && now - since >= 30000;
    if (['stop_rejected', 'stop_repeatedly_rejected', 'stop_outcome_unknown','stop_order_unverified','stop_session_expired','stop_repair_required','stop_rearm_pending'].includes(stop) || pendingTooLong ||
      stop === 'stop_unavailable_now' && session.minute >= session.entry_start_minute) {
      issues.push({code: 'broker_protection_unverified', urgent: true,
        message: 'QQQ broker-held emergency protection is rejected, unavailable, or still unconfirmed. Review the trading task.'});
    }
  }
  if (policyError) issues.push({ code: 'policy_unavailable', urgent: holding,
    message: 'QQQ approved risk policy is unavailable or invalid. New entries are blocked.' });
  if (stateError) issues.push({ code: 'trade_state_unavailable', urgent: true,
    message: 'QQQ local trade state cannot be read. Review the trading task.' });
  if (!session?.verified) issues.push({ code: 'calendar_unverified', urgent: holding,
    message: 'QQQ market calendar is unavailable for this date. New entries are blocked.' });
  if (holding && session?.is_open) {
    const at = Date.parse(watch?.observed_at ?? '');
    const age = now - at;
    if (Number.isFinite(at) ? age < -5000 || age > watchLimitMs : now - startedAt > watchLimitMs) {
      issues.push({ code: 'watch_delayed', urgent: true,
        message: 'QQQ profit review is more than two minutes old or unavailable while a trade may be open.' });
    }
    if (watch?.outcome === 'error' || watch?.outcome === 'data_unavailable') {
      issues.push({ code: 'watch_failed', urgent: true,
        message: 'The latest QQQ trading review reported unavailable data or an error while a trade may be open.' });
    }
  }
  return issues;
}

export function changedIssues(previous, current) {
  const known = new Set((previous ?? []).map(issue => `${issue.code}:${Boolean(issue.urgent)}`));
  const present = new Set(current.map(issue => issue.code));
  return { added: current.filter(issue => !known.has(`${issue.code}:${Boolean(issue.urgent)}`)),
    recovered: (previous ?? []).filter(issue => !present.has(issue.code)) };
}
