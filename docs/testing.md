# Testing

Run `npm ci --ignore-scripts`, `npm run check`, `npm test` and `npm run demo`. Tests use Node's built-in runner, temporary directories, synthetic fixtures and mocked broker calls. They do not authorize or submit brokerage orders.

The initial public release passes 385 tests. Coverage includes completed-bar rules, causal setup discovery, risk arithmetic, approval hashing, session boundaries, ownership checks, stop/order recovery, freshness, journal redaction, replay gaps, report escaping, account identity and disabled broker dispatch.

Some arithmetic tests intentionally supply high synthetic risk fractions to test independent loss-budget boundaries. Those values are not the public defaults or recommendations. Historical capture-dependent tests from the originating installation are not distributed; synthetic scanner, calendar and halt fixtures cover selected replacement cases. Public test counts therefore differ from that installation.

CI runs syntax checks, the test suite, synthetic demo and the Git-tracked publication guard on Linux with Node 20 and 22. The release was also exercised locally on macOS. The HTML preview is manually checked for filtering and readability. No live broker integration, performance benchmark, trade profitability or uninterrupted deployment is asserted by a passing CI run.

## Adding useful cases

Prefer boundary or failure cases that would change a decision: a forming bar, future timestamp, expired plan, changed position lifetime, unverified cancellation, stale quote or unavailable sample. Keep expected values independent of the function being tested. Use invented account IDs and market paths, and do not add live fixtures or network calls to tests.
