# Experimental broker integration

The supported quickstart is offline. The repository retains a Robinhood trading MCP adapter and execution modules for developers studying or extending the system. Access depends on the broker's service, account eligibility and permissions; this release does not establish that a new account can connect.

## Platform boundary

Pure logic, demo and tests run in Node.js. Credential persistence uses macOS Security.framework through the included Swift helper sources. Linux and Windows need a separately implemented credential provider for brokerage integration. No prebuilt helper binary or credential is included.

Developers on macOS can compile the helpers locally:

```bash
swiftc src/keychain.swift -o src/keychain
swiftc src/external-keychain.swift -o src/external-keychain
```

The OAuth helper uses the Keychain service `org.qqq-1dte-watch.oauth`; the optional external-monitor helper uses `org.qqq-1dte-watch.external-heartbeat`. These are distinct from the originating private installation. Do not change them to reuse another application's grants.

## Explicit boundaries

`broker-config.mjs` blocks connections before credential access unless broker access is explicitly enabled. Calls to `place_option_order` and `cancel_option_order` additionally require live-order opt-in and the exact configured account. Unknown mutating tools are rejected. Read calls do not imply permission to trade.

Account selection also requires a single active eligible account. Missing identity, suffix-only matches and ambiguous eligible-account lists fail. The entry path still requires a complete approved risk policy, freshness, contract checks, protection readiness and state reconciliation. Environment flags alone do not satisfy those gates.

`probe.mjs auth` and `probe.mjs check` are operator tools for a separately configured integration. The authorization callback binds to loopback port 8765. These tools may show account-related information in the terminal, so do not publish their output. The public demo never imports or invokes the authorization entrypoint.

## Deployment work that remains

This release does not install a scheduler, launch agent, watchdog, external heartbeat service or monitoring alerts. The inherited CLIs use source-adjacent mutable state. A production integration needs its own storage isolation, service supervision, restart validation, broker entitlement checks and supervised end-to-end verification.

Do not combine read-only mode with an expectation of order protection: disabled mutations also block protective stop placement and cancellations. Opt-in flags are configuration gates, not a security boundary against code running with your credentials. Tests use mocks and cannot establish broker behavior or execution quality.

The QQQ chain identifier in the inherited monitor is broker instrument metadata, not an account ID; it must be validated against the intended broker before an integration is used.
