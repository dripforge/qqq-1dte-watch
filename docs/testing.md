# Testing

Run `npm ci --ignore-scripts`, `npm run check`, `npm test` and `npm run demo`. Tests use Node's built-in runner, temporary directories, synthetic fixtures and mocked broker calls. They do not authorize or submit brokerage orders.

The initial public release passes 398 tests. Coverage includes completed-bar rules, causal setup discovery, risk arithmetic, approval hashing, session boundaries, ownership checks, stop/order recovery, freshness, journal redaction, replay gaps, report escaping, account identity, disabled broker dispatch, runtime isolation, version consistency and deleted-secret detection across Git history.

Some arithmetic tests intentionally supply high synthetic risk fractions to test independent loss-budget boundaries. Those values are not the public defaults or recommendations. Historical capture-dependent tests from the originating installation are not distributed; synthetic scanner, calendar and halt fixtures cover selected replacement cases. Public test counts therefore differ from that installation.

CI runs syntax checks, the test suite, synthetic demo and the Git-tracked publication guard on Linux with Node 20 and 22. The release was also exercised locally on macOS. The HTML preview is manually checked for filtering and readability. The four synthetic decision records are evaluated from inputs; tests change those inputs and verify that the blocked stage changes. No-obstacle evidence does not become a room approval, and offline execution always blocks. No live broker integration, performance benchmark, trade profitability or uninterrupted deployment is asserted by a passing CI run.

## Adding useful cases

Prefer boundary or failure cases that would change a decision: a forming bar, future timestamp, expired plan, changed position lifetime, unverified cancellation, stale quote or unavailable sample. Keep expected values independent of the function being tested. Use invented account IDs and market paths, and do not add live fixtures or network calls to tests.

## Publication guard

`npm run check:public` checks current tracked working files, staged blobs and every commit tree reachable from local branches, remote-tracking refs and tags. CI fetches full history; a shallow repository fails rather than claiming complete coverage. For a local audit after remote updates, run `git fetch --all --tags` first. Unreferenced objects and refs not fetched locally are outside this scope.

Tests create temporary Git repositories and plant invented token patterns, then verify detection after removal from the latest tree, after staging, and after an unstaged edit. The guard rejects source symlinks, disallowed runtime files and approved example policies. It reports categories and locations without printing matched secret values. It remains a targeted scanner, not proof that arbitrary secrets or sensitive screenshots are absent; preview images require visual review.
