# Security

The public 0.1.x release is experimental. Please report credential exposure, account-selection failures, unintended order dispatch or unsafe handling of untrusted report input through the repository's **Security → Report a vulnerability** feature when available. Do not include credentials or real account data in a public issue. If private reporting is unavailable, open a minimal issue requesting a private reporting channel without exploit details or sensitive data.

Only the latest public revision receives fixes. The maintainers make no response-time or trading-availability commitment.

Broker access is disabled by default. Keep credentials in the configured Keychain provider, use an isolated runtime checkout, and review data before sharing logs or screenshots. Never assume a stop order guarantees a maximum loss. If a real credential is exposed, revoke it through its issuing service; removing a Git commit is not revocation.
