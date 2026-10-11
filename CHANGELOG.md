# Changelog

## 0.1.1 — 2026-10-11

- Replace account-specific public defaults with round, configurable demonstration limits: $300 premium per contract and $100 absolute daily loss. The 1% per-trade and 3% daily arithmetic defaults remain illustrative.
- Keep the unapproved example, arithmetic defaults, research selection and documentation consistent. No approved policy or live-order opt-in is included.
- Move the fixed research replay to specification version 2 with a $300 premium cap. Its changed hash invalidates verification of earlier freezes; a new prospective freeze is required.

## 0.1.0 — 2026-10-11

First public release of QQQ 1DTE Watch.

- Completed-candle setup discovery, obstacle review and intraday decision auditing.
- Conservative quote replay with explicit unavailable and nonmarketable outcomes.
- Synthetic offline demo, searchable report and documented research boundaries.
- Experimental MCP integration with separate broker/order opt-ins and exact account identity.
- Isolated credential namespaces, illustrative unapproved policy, MIT license and contribution guidance.
- Synthetic/mocked regression suite with 398 tests and GitHub Actions validation.
- Input-driven offline checks, isolated runtime directories and a single package-derived application version.
- Publication checks cover staged bytes and reachable Git history, including deleted dummy-secret regression cases.
- Reviewed Actions v7 updates, pinned to verified commits, with full-history checkout.
- Shorter JPEG preview and a tagged GitHub release.

Private account state, captured market fixtures, deployment services and journals are excluded.
