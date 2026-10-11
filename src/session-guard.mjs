import { marketSession, expirationStatus } from './session.mjs';

// mcp.call runs this callback after obtaining the shared broker lock, immediately
// before dispatch. A local rejection therefore proves no order was sent.
export function sessionSubmissionGuard(arm, { stop = false, clock = () => Date.now() } = {}) {
  return () => {
    try {
      const now = new Date(clock());
      const session = marketSession(now);
      const expiration = expirationStatus(arm.expiration_date, now);
      if (!session.is_open || !expiration.verified || expiration.expired ||
          stop && session.minute < session.entry_start_minute) {
        throw new Error(`Order session changed before submission: ${!expiration.verified ? expiration.reason : session.reason}${expiration.window_missed ? '; expiration exit window missed' : ''}`);
      }
      return session;
    } catch (error) {
      error.code = 'LOCAL_PREFLIGHT';
      throw error;
    }
  };
}
