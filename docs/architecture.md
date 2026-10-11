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

Program manifests hash on-disk modules, excluding test files, plus a package manifest when present in the same directory. This identifies bytes observed by the recorder. It does not prove that a resident process has loaded those bytes; service version and freshness are separate evidence. Release version `0.1.0` is the public distribution version; the inherited protection engine reports its internal version `2.5.0`.

## Order state is a separate concern

The broker adapter serializes access with a process lock. Order submission records intent before dispatch. Unknown outcomes require reconciliation rather than another speculative submission. Position ownership checks include contract and position lifetime so a close request cannot silently follow a different holding.

Protection logic evaluates filled-position evidence and broker stop state independently from research. Supplemental collectors yield to broker contention; they do not establish that protection is healthy. The adapter's `connectReadOnly` name describes the connection helper, not a broker permission sandbox. All mutations additionally pass through public-distribution gates in `call()`.

## Runtime and scheduling

No background service is installed by this repository. The core supports periodic checks, but one-minute timing requires an external scheduler and measured runtime. Long-running checks, market closures and scheduler behavior can produce completion gaps.

Several inherited CLI modules store mutable files next to their source. `artifacts/demo/` is isolated; advanced integration must use a dedicated disposable checkout with restricted filesystem permissions. Do not point this distribution at an existing installation or share its credential namespace. Moving all runtime state behind an injected storage adapter is an explicit roadmap item.
