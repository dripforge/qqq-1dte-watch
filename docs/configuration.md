# Configuration

The offline demo has no required environment variables. `npm run demo` always uses the synthetic generator and writes only its demo artifacts.

## Broker switches

| Variable | Default | Purpose |
| --- | --- | --- |
| `QQQ_ENABLE_BROKER` | Disabled | Exactly `1` permits adapter connections/read calls. |
| `QQQ_ENABLE_LIVE_ORDERS` | Disabled | Exactly `1`, plus broker opt-in, permits supported order mutations. |
| `QQQ_ACCOUNT_NUMBER` | Unset | Exact eligible account identity; no suffix matching or automatic selection. |
| `QQQ_RUNTIME_DIR` | Project `runtime/` | Optional absolute directory for private state and shared process locks. |

`.env.example` is a template, not an automatically loaded file. Keep real values in your local environment or secret manager. The public adapter uses a separate Keychain service namespace from any previous private installation.

## Risk policy

`examples/policy.example.json` documents the schema and has `approved: false`. It is deliberately rejected by the approval validator. There is no shipped `src/policy.json` and no command that automatically approves a policy.

A live policy requires every field, an explicit approval flag, revision and UTC recording timestamp. Changes invalidate the saved policy snapshot. The public arithmetic defaults are 1% of equity per trade and 3% per day with a $250 absolute daily ceiling, $325 opening premium ceiling and $1 execution cushion. Those numbers are illustrative engineering defaults. Approved policies can differ within schema bounds; the default function does not constrain an explicit policy to these percentages.

Planned risk reserves 25% of the opening premium plus the cushion, matching the inherited broker-stop model. **Reserved risk is not maximum possible loss.** Gap moves, outages, rejected orders and option liquidity can produce losses beyond the planned amount.

## Sessions

All session gates use America/New_York with daylight-saving handling. Regular-session entries run from 9:45 a.m. to strictly before 3:58 p.m. The entry cutoff on an early-close day is one hour before the calendar close. The separate expiration-day exit threshold is 15 minutes before close; changing entry time does not change that threshold.

Weekend and scheduled-holiday sessions are closed. Session metadata is in `src/session-calendar.json`, including its coverage and source URLs. A scheduler is external to this repository; closed-session logic does not stop an arbitrary scheduler from waking a process.

## Local state

Policies, journals, health, order intent, locks and saved research default to `runtime/` beside `package.json`. Source and helper executables remain in `src/`. The runtime path does not depend on the shell working directory. Every service in one installation must use the same `QQQ_RUNTIME_DIR`. Explicit CLI report paths can use `artifacts/` or an external directory.

There is no automatic migration from old source-adjacent files. While fully stopped and with no unresolved orders or positions, an operator can review and transfer required state to the new runtime location. Never start a second installation against the same account to bypass unresolved state.

The report CLI accepts an explicit folder:

```bash
node src/decision-audit.mjs artifacts/demo
node src/decision-audit.mjs artifacts/demo 2026-10-08 12:00
```

The first command refreshes reports using the current clock. The second explains recorded completions for one Eastern-time minute. To reproduce the fixed demo clock, use `npm run demo`.

Never commit real `journal.jsonl`, account values, OAuth grants, approved policies, state snapshots, order IDs, screenshots containing holdings, or service logs. The publication check supplements `.gitignore`; it is not a complete secret scanner.
