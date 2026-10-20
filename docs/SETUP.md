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

M4 adds offline evaluation and human review without requiring credentials. Scenario A includes an explicitly labeled intentionally incorrect outage fixture; it is synthetic evaluation data, not an observed model result. Reject it with the authentication correction, then load another analysis to inspect that feedback in its saved context. Scenario B's fixture requires all three subscription webhook attempts to be linked to the case. Scenario C is available only while the case has no linked diagnostic records. Fixtures never claim a provider, model, response ID, or live execution.

Each analysis saves the exact case, activity, linked evidence, knowledge entries, and prior rejection feedback supplied to it, together with the IDs it was allowed to cite. Later case changes do not alter that snapshot. The app checks structured references against this saved allowlist; a valid citation confirms only that the record was supplied, not that the interpretation is true. Unsupported references stay visible and block approval and draft reuse, while rejection remains available.

Accepting or editing a recommendation appends a review and preserves the original analysis. To use an approved response, choose **Use reviewed draft**; it fills the existing composer only after you choose whether to replace unsent text. It does not record or send a reply. **Record simulated reply** remains a separate action, and case status changes remain separate as well. Rejecting a recommendation records corrective feedback; a later analysis captures that feedback in its own snapshot. Review history is append-only.

### Optional live analysis

Live inference is optional and uses the server-side OpenAI Responses API with Structured Outputs. To enable it, set the credential in the server process environment before starting the app:

    export OPENAI_API_KEY="your-key"
    export OPENAI_MODEL="gpt-6.1-sol"  # optional; this is the default
    npm start

Keep the key out of source files, browser settings, client bundles, and logs. `OPENAI_MODEL` is configurable; the server does not silently switch models. The integration sends the saved context with `store: false`, no tools, SDK retries disabled, and a bounded timeout. The local SDK transport tests use a mocked HTTP response and do not constitute real model verification. A real request requires an authorized API account with access to the configured model. With no key, manual, diagnostic, fixture, and review workflows continue to work.

## Synthetic investigation records

Search accepts one exact, case-sensitive row ID, request ID, or event ID. Surrounding whitespace is trimmed. Search results are global, so inspect the organization before selecting rows to associate. The app displays every webhook attempt in the matching organization/event history; reading a history does not associate any row.

| Scenario | Case | Stable search IDs | Expected evidence |
| --- | --- | --- | --- |
| A — authentication | `SEW-1001` / `ORG-ALDER-01` | `req_auth_20261019_001`, `req_auth_20261019_002`, `req_auth_20261019_003`; rows `DIAG-AUTH-401-001` through `DIAG-AUTH-401-003` | Three linked HTTP 401 API observations. Inspect `KB-AUTH-01`; repeated 401 responses alone do not establish a provider outage. |
| B — subscription webhook | `SEW-1002` / `ORG-CEDAR-02` | Event `evt_subscription_480`; rows `DIAG-WH-SUB-001`, `DIAG-WH-SUB-002`, `DIAG-WH-SUB-003` | Initially unlinked attempts: HTTP 500, timeout with no HTTP response, then HTTP 204 acknowledgment. The acknowledgment does not establish downstream processing. |
| B — invoice webhook | `SEW-1002` / `ORG-CEDAR-02` | Event `evt_invoice_731`; rows `DIAG-WH-INV-001`, `DIAG-WH-INV-002` | Initially unlinked attempts: HTTP 503, then a pending retry with no observed delivery time or response. |

| Unrelated organization | No case | Row `DIAG-OTHER-001`; event ID `evt_subscription_480` | Global search also returns `ORG-MAPLE-99`. Its history stays separate from Cedar’s same-ID event, and its row cannot be linked to another organization’s case. |
| C — missing evidence | `SEW-1003` | For a reproducible no-result check, search `req_missing_case_c_20261020` | No diagnostic is seeded for this case. The empty result does not imply that a failure or outage occurred. Ask for an exact request ID and UTC window, or escalate with no evidence. |

Fixture B is available only after an operator explicitly links all five subscription and invoice attempts. It discusses the HTTP 500, timeout, HTTP 204 acknowledgment, HTTP 503, and pending retry while keeping downstream processing unknown.

The four inspectable knowledge entries are `KB-AUTH-01`, `KB-WEBHOOK-01`, `KB-REQUEST-01`, and `KB-OUTAGE-01`. They are fictional, versioned plain text; there is no retrieval service or generated guidance.

### Observed outcomes

- A 2xx response is shown as **“Acknowledged by endpoint; downstream processing not observed.”**
- A timeout is shown as **“No HTTP response observed.”**
- A pending retry is shown as **“Pending retry; no observed delivery time or response.”**

Unknown response and timestamp values remain unknown. Diagnostic rows and knowledge entries are read-only. Escalation records the selected already-linked diagnostic IDs as a historical snapshot; later associations do not alter earlier escalation history. Empty-evidence escalation remains available.

## Durable data, initialization, and reset

SQLite schema version 5 adds exactly `analyses` and `reviews` to the M1–M3 tables. Migration 5 preserves case data, activities and their sequence numbers, evidence associations, diagnostic and knowledge fixtures, and mutation receipts. Analyses persist their source, saved context and reference allowlist, lifecycle status, structured recommendation, validation, and available live-provider metadata. Reviews are append-only. Live requests are reserved transactionally before inference; inference happens outside the transaction. A process restart marks any still-running live analysis as interrupted instead of resending it. Only one live analysis can be running for a case at a time. Offline fixtures do not claim provider execution metadata.

Case updates and association writes use expected versions and idempotency receipts. Repeating the same key and payload replays its committed response, including after restart. Reusing a key with different content or submitting a new request against a stale case version returns a conflict. Evidence batches are validated together; unknown or wrong-organization records produce no partial changes. Duplicate links are deduplicated, and an all-already-linked request is a no-op.

Each browser tab retains case-scoped drafts, selected diagnostic IDs, and exact pending requests in session storage. Association retries reuse the original key and payload after an uncertain connection. Conflicts require explicit reload and review; drafts and evidence selections remain available.

To check persistence manually, stop the server, run **npm run db:init**, and start it again. Case state and history remain in the database. To restore the complete initial synthetic baseline, stop the server and run:

    npm run demo:reset -- --confirm

Reset clears cases, activities, associations, technical fixtures, knowledge entries, analyses, reviews, and mutation receipts in this project’s recognized demo database, then restores the initial reports, A’s seed links, unlinked B events, and four knowledge entries. It refuses to run without confirmation or against a custom database path. Do not reset if you need local demo changes.

## Verification

Run database, migration, and HTTP checks with:

    npm test

Build and run the Chromium journeys with:

    npx playwright install chromium
    npm run test:e2e

The browser suite uses a temporary SQLite database and does not touch the local demo database. It covers A’s incorrect offline fixture, authentication correction, and reanalysis context; B’s evidence prerequisites, edited approval, unsent-draft preservation, and separate simulated-reply action; C’s uncertainty-first acceptance and draft reuse; and the existing M1–M3 manual, diagnostic, evidence-association, conflict, persistence, and history workflows. Database and API tests also cover atomic reservations and reviews, idempotency, saved-context isolation, supplied-reference validation, interruption recovery, late-result fencing, provider failure/refusal/incomplete/timeout handling, and safe SDK transport behavior. CI makes no paid API request. Passing local transport tests do not verify live model behavior.

## Milestone status

This branch implements the Product Owner-authorized M4 handoff from approved M3 integration SHA `02c22bb11e5e2e2ae177507f26c16e5275b6eee2`. M4 adds saved-context AI analysis, three offline evaluation fixtures, append-only human review, and explicit draft reuse. Review does not send messages or change case status. No agent framework, tool calling, external messaging, delivery replay, event ingestion, production authentication, or deployment feature is included. M4 acceptance and merge remain separate decisions.
