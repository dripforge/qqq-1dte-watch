# Architecture

The toolkit keeps evidence validation, broker dispatch, protection and retrospective research in separate modules. Most logic is deterministic and accepts a clock or test input. CLI programs orchestrate local state and optional broker calls.

## Module map

| Area | Start reading here |
| --- | --- |
| Calendar and session gates | `src/session.mjs`, `src/session-guard.mjs` |
| Candle validation and discovery | `src/setup-policy.mjs`, `src/setup-scan.mjs` |
| Room and invalidation | `src/setup-review.mjs`, `src/invalidation.mjs` |
| Contract and risk constraints | `src/contract-selection.mjs`, `src/risk-policy.mjs`, `src/approved-risk-policy.mjs` |
| Entry intent and recovery | `src/entry.mjs`, `src/entry-recovery.mjs`, `src/entry-watch-plan.mjs` |
| Order ownership and dispatch | `src/position-ownership.mjs`, `src/owned-dispatch.mjs`, `src/orderflow.mjs` |
| Protection and readiness | `src/monitor.mjs`, `src/emergency.mjs`, `src/protection-readiness.mjs` |
| Decision evidence and audit | `src/audit-record.mjs`, `src/record-run.mjs`, `src/decision-audit.mjs` |
| Research and replay | `src/research-record.mjs`, `src/research-collector.mjs`, `src/conservative-replay.mjs` |
| Supplemental context | `src/analysis-context.mjs`, `src/event-context.mjs`, `src/halt-context.mjs` |
| Broker boundary | `src/broker-config.mjs`, `src/mcp.mjs`, `src/broker-access.mjs` |

## Evidence before action

Setup discovery uses references established before a completed break. A later completed five-minute confirmation and the latest completed one-minute follow-through are separate requirements. Discovery can produce a candidate that still needs entry validation; it never authorizes an order.

A recorded check may include nine stages: session, service, position, structure, follow-through, room, contract, risk and entry. Each stage is `pass`, `block`, `not_evaluated` or `unavailable`. Legacy records retain their original summary; the report does not reconstruct missing stage outcomes.

Program manifests hash on-disk modules, excluding test files, plus the root package manifest. This identifies bytes observed by the recorder. It does not prove that a resident process has loaded those bytes; service version and freshness are separate evidence. `package.json` is the single application-version source for the monitor, MCP client, audit reports and version CLI. Schema versions describe data formats and remain independent of the application version.

## Order state is a separate concern

The broker adapter serializes access with a process lock. Order submission records intent before dispatch. Unknown outcomes require reconciliation rather than another speculative submission. Position ownership checks include contract and position lifetime so a close request cannot silently follow a different holding.

Protection logic evaluates filled-position evidence and broker stop state independently from research. Supplemental collectors yield to broker contention; they do not establish that protection is healthy. The adapter's `connectReadOnly` name describes the connection helper, not a broker permission sandbox. All mutations additionally pass through public-distribution gates in `call()`.

## Runtime and scheduling

No background service is installed by this repository. The core supports periodic checks, but one-minute timing requires an external scheduler and measured runtime. Long-running checks, market closures and scheduler behavior can produce completion gaps.

Mutable state defaults to an ignored `runtime/` directory anchored to the project, independent of the working directory. An absolute `QQQ_RUNTIME_DIR` selects an external installation. CLI paths reject source directories, repository metadata and symlinks into those locations. Explicit report folders may use ignored `artifacts/`. Newly created runtime directories use owner-only permissions.

Child entry processes execute the source program and inherit the selected runtime directory through their environment. Broker connections retain that runtime location for subsequent lock acquisition. Code fingerprints always hash source modules and `package.json`; manifests are saved under the runtime directory. Swift helper executables and immutable session metadata remain in `src/`.

Existing state is never automatically moved or loaded from `src/`. Reconfigure all processes consistently before a supervised deployment. Do not switch runtime directories while an order or position needs reconciliation.
