# Local setup and investigation demo

## Requirements

- Node.js **24.15.0** and npm from that installation.
- Chromium for `npm run test:e2e` (`npx playwright install chromium`). GitHub Actions installs Chromium and its Linux dependencies automatically.

Node 24.15.0 marks `node:sqlite` as a release candidate. The automated checks use file-backed SQLite migrations and persistence. See the [Node 24.15.0 SQLite documentation](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html).

## Install and run

From the repository root:

    nvm install
    nvm use
    npm ci
    npm run db:init
    npm run build
    npm start

Open <http://127.0.0.1:3000>. The queue contains three fictional cases. Review the case history, record internal notes, record clearly labeled simulated replies, and update status. Each case also includes diagnostic search, linked evidence, and read-only technical guidance. No message leaves the app, diagnostics cannot trigger deliveries, and no AI credentials are needed.

## Synthetic investigation records

Search accepts one exact, case-sensitive row ID, request ID, or event ID. Surrounding whitespace is trimmed. Search results are global, so inspect the organization before selecting rows to associate. The app displays every webhook attempt in the matching organization/event history; reading a history does not associate any row.

| Scenario | Case | Stable search IDs | Expected evidence |
| --- | --- | --- | --- |
| A — authentication | `SEW-1001` / `ORG-ALDER-01` | `req_auth_20261019_001`, `req_auth_20261019_002`, `req_auth_20261019_003`; rows `DIAG-AUTH-401-001` through `DIAG-AUTH-401-003` | Three linked HTTP 401 API observations. Inspect `KB-AUTH-01`; repeated 401 responses alone do not establish a provider outage. |
| B — subscription webhook | `SEW-1002` / `ORG-CEDAR-02` | Event `evt_subscription_480`; rows `DIAG-WH-SUB-001`, `DIAG-WH-SUB-002`, `DIAG-WH-SUB-003` | Initially unlinked attempts: HTTP 500, timeout with no HTTP response, then HTTP 204 acknowledgment. The acknowledgment does not establish downstream processing. |
| B — invoice webhook | `SEW-1002` / `ORG-CEDAR-02` | Event `evt_invoice_731`; rows `DIAG-WH-INV-001`, `DIAG-WH-INV-002` | Initially unlinked attempts: HTTP 503, then a pending retry with no observed delivery time or response. |
| Unrelated organization | No case | Row `DIAG-OTHER-001`; event ID `evt_subscription_480` | Global search also returns `ORG-MAPLE-99`. Its history stays separate from Cedar’s same-ID event, and its row cannot be linked to another organization’s case. |
| C — missing evidence | `SEW-1003` | For a reproducible no-result check, search `req_missing_case_c_20261020` | No diagnostic is seeded for this case. The empty result does not imply that a failure or outage occurred. Ask for an exact request ID and UTC window, or escalate with no evidence. |

The four inspectable knowledge entries are `KB-AUTH-01`, `KB-WEBHOOK-01`, `KB-REQUEST-01`, and `KB-OUTAGE-01`. They are fictional, versioned plain text; there is no retrieval service or generated guidance.

### Observed outcomes

- A 2xx response is shown as **“Acknowledged by endpoint; downstream processing not observed.”**
- A timeout is shown as **“No HTTP response observed.”**
- A pending retry is shown as **“Pending retry; no observed delivery time or response.”**

Unknown response and timestamp values remain unknown. Diagnostic rows and knowledge entries are read-only. Escalation records the selected already-linked diagnostic IDs as a historical snapshot; later associations do not alter earlier escalation history. Empty-evidence escalation remains available.

## Durable data, initialization, and reset

SQLite schema version 4 adds exactly `diagnostics`, `case_evidence`, and `knowledge_entries` to the M1/M2 tables `cases`, `activities`, and `mutation_receipts`. Migration 4 preserves existing case data, M2 activities, activity sequences, and receipts. Initial fixture installation is transactional. Initialization associates A’s three synthetic 401 rows only when `SEW-1001` exists for `ORG-ALDER-01`; that change appends an auditable synthetic-seed activity and advances A’s version once. Repeated initialization preserves operator associations, case history, and request receipts.

Case updates and association writes use expected versions and idempotency receipts. Repeating the same key and payload replays its committed response, including after restart. Reusing a key with different content or submitting a new request against a stale case version returns a conflict. Evidence batches are validated together; unknown or wrong-organization records produce no partial changes. Duplicate links are deduplicated, and an all-already-linked request is a no-op.

Each browser tab retains case-scoped drafts, selected diagnostic IDs, and exact pending requests in session storage. Association retries reuse the original key and payload after an uncertain connection. Conflicts require explicit reload and review; drafts and evidence selections remain available.

To check persistence manually, stop the server, run **npm run db:init**, and start it again. Case state and history remain in the database. To restore the complete initial synthetic baseline, stop the server and run:

    npm run demo:reset -- --confirm

Reset clears cases, activities, associations, technical fixtures, knowledge entries, and mutation receipts in this project’s recognized demo database, then restores the initial reports, A’s seed links, unlinked B events, and four knowledge entries. It refuses to run without confirmation or against a custom database path. Do not reset if you need local demo changes.

## Verification

Run database, migration, and HTTP checks with:

    npm test

Build and run the Chromium journeys with:

    npx playwright install chromium
    npm run test:e2e

The browser suite uses a temporary SQLite database and does not touch the local demo database. It covers A’s linked 401 records and KB inspection; B’s global search, complete organization-scoped histories, wrong-organization rejection, association, and evidence-backed escalation; C’s no-results and empty-evidence path; case/filter/draft preservation; association conflicts and exact retries after a lost acknowledgment; and the M2 manual workflow, history, UTC labels, terminal resolution, stale-response protection, and concurrent-tab recovery.

## Milestone status

The M3 implementation is on an isolated branch based on approved M2 integration SHA `f5de45fcfc8a73aeee4acf62f1888836cce40233`. Independent technical review, Product Owner acceptance, merge, and integrated CI are pending. M4 analysis and review workflows remain future work. No external messaging, delivery replay, event ingestion, authentication, or deployment feature is included.
