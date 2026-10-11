# Research methodology

The central question is: what could be concluded from evidence available at that timestamp? The toolkit does not optimize its rules using a reconstructed winning trade.

## Three fixed quote scenarios

| Scenario | Entry delay | Adverse price stress per side |
| --- | --- | --- |
| Immediate touch | 0 seconds | $0.00 per share |
| Delayed 10 seconds | 10 seconds | $0.01 per share |
| Delayed 30 seconds | 30 seconds | $0.03 per share |

The original observed ask defines a fixed buy limit. A later ask plus stress above that limit produces `not_marketable_at_sample`. Usable paths value entry at the ask and exit at the bid; results are for one 100-share-multiplier option contract over a 60-second horizon. A separate hypothetical fee stress applies $0.65 per side. These are model inputs, not claims about a broker's current fees or executable prices.

Quotes require known positive sizes, coherent bid/ask, the same Eastern session, no future timestamp, and age of at most five seconds. The replay also limits sampling lateness and path gaps to 20 seconds. Missing evidence produces `unavailable`; it is not interpolated. A sparse path can remain incomplete even when an attractive later quote exists.

The demo supplies three invented research cases. Together they yield nine scenario rows, including unavailable and nonmarketable outcomes. It is a mechanics demonstration, not a backtest.

## Avoiding hindsight

The research specification has a content hash. `createReplayFreeze()` fixes 20 future calendar-verified calibration sessions followed by 10 evaluation sessions. A valid freeze must predate the relevant observations. Without a verified freeze and chronological split, results remain exploratory or explicitly lack a usable split.

Overlapping cases are grouped into episodes. The first case is selected before reading the outcome; an unavailable first case cannot be replaced by a later winner. Setup, early-break and other signals remain separate. Reporting is limited to retained cases, with missing/censored evidence shown.

## Attribution and context

Greek attribution needs paired quotes, underlying prices, implied volatility and verified units: theta per calendar day and vega per volatility point. The helper reports an approximation and unexplained residual. Automatic attribution remains unavailable when those prerequisites are missing.

Supplemental context can include a fixed ETF/large-cap basket, VIX/NDX/SPX, official macro calendars and a Nasdaq halt feed. Feed coverage and freshness are explicit. Date-only events do not acquire invented times; missing calendar or halt data does not mean a quiet or tradable market. Supplemental context is research-only and does not silently become an execution filter.

## Limits

- Quote scenarios do not demonstrate fills, queue position, market impact, entry eligibility or the performance of the full exit strategy.
- The included calendar covers scheduled sessions from 2026 through 2028. Beyond coverage, session logic fails closed. Unexpected closures still require fresh market evidence.
- Historical stage checks absent from the journal cannot be recovered from a later chart.
- Tightened setup-based stops and early-break entries remain research ideas. A report does not enable them.
- The project ships no historical market dataset, returns series, Sharpe ratio or verified strategy win rate.
