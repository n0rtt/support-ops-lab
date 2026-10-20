# Local setup and demo data

## Requirements

- Node.js **24.15.0** and npm from that installation (`.nvmrc` pins the Node version).
- Chromium for browser journeys (`npx playwright install chromium`).

Node 24.15.0 documents `node:sqlite` as a release candidate. The project uses file-backed SQLite; see the [versioned Node documentation](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html).

## Install and run without AI credentials

From the repository root:

```sh
nvm install
nvm use
npm ci
npm run db:init
npm run build
npm start
```

Open <http://127.0.0.1:3000>. The server binds to loopback. No API key is required for manual case work, diagnostics, fixtures, or review.

Live model inference is unavailable without a server-side key; the interface says so and keeps the rest of the workbench available. Offline fixtures do not make provider requests and do not include invented provider, model, or response metadata.

## Optional live analysis

Live analysis uses the server-side OpenAI Responses API with Structured Outputs. Configure the server environment before starting it:

```sh
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="gpt-6.1-sol"  # optional; this is the default
npm start
```

Keep credentials outside source files, browser settings, client assets, and logs. The model setting is server-side and has no automatic fallback. Requests use the saved case context, `store: false`, no tools, disabled SDK retries, and a bounded timeout. Do not use a live key to run the deterministic test suite; CI makes no paid request.

M4 genuine inference was separately accepted by the Product Owner for synthetic case `SEW-1003`, requested/returned model `gpt-6.1-sol`, analysis `AN-ea755d67-414c-4ac5-86eb-cb5116ea1c71`. M5 makes no new paid request. See the [engineering history](ENGINEERING_HISTORY.md) for the accepted record and limits.

## Synthetic investigation records

Search accepts one exact, case-sensitive row ID, request ID, or event ID after trimming surrounding whitespace. Results are global; inspect organization ownership before association. Reading a history does not associate any rows.

| Scenario | Case and organization | Exact search IDs | Starting evidence |
| --- | --- | --- | --- |
| A — authentication | `SEW-1001` / `ORG-ALDER-01` | `req_auth_20261019_001`, `req_auth_20261019_002`, `req_auth_20261019_003`; rows `DIAG-AUTH-401-001`–`DIAG-AUTH-401-003` | Three linked HTTP 401 observations. Inspect `KB-AUTH-01`; they support an authentication investigation and do not establish a provider outage. |
| B — subscription webhook | `SEW-1002` / `ORG-CEDAR-02` | Event `evt_subscription_480`; rows `DIAG-WH-SUB-001`–`DIAG-WH-SUB-003` | Initially unlinked attempts: HTTP 500, timeout with no HTTP response, then HTTP 204 endpoint acknowledgment. Downstream processing is unobserved. |
| B — invoice webhook | `SEW-1002` / `ORG-CEDAR-02` | Event `evt_invoice_731`; rows `DIAG-WH-INV-001`–`DIAG-WH-INV-002` | Initially unlinked attempts: HTTP 503, then a pending retry with no observed time or response. |
| Same ID, other organization | No case / `ORG-MAPLE-99` | Row `DIAG-OTHER-001`; event ID `evt_subscription_480` | Global lookup also returns Maple's separate history. Its row cannot be linked to Cedar's case. |
| C — insufficient evidence | `SEW-1003` | `req_missing_case_c_20261020` | No diagnostic is seeded for this ID. An empty search is missing evidence; it does not establish a failure or outage. |

The Scenario B fixture remains unavailable until **all five** Cedar subscription and invoice attempt rows have been explicitly associated with `SEW-1002`. The fixture then discusses HTTP 500, timeout, HTTP 204 acknowledgment, HTTP 503, and pending retry while leaving downstream processing unknown.

The four fixed knowledge entries are `KB-AUTH-01`, `KB-WEBHOOK-01`, `KB-REQUEST-01`, and `KB-OUTAGE-01`. They are fictional versioned text, not generated guidance or a retrieval service.

## Analysis and review behavior

Each saved analysis includes the exact case, activity, linked evidence, knowledge entries, and prior rejection feedback supplied to it, plus the IDs it may cite. Later changes do not alter that snapshot. A structured reference is checked against that saved allowlist; membership confirms that a source was supplied, not that a claim is true. Unsupported references remain visible and block approval and reviewed-draft reuse. Rejection remains available.

The A outage conclusion is an intentionally incorrect evaluation fixture. Rejecting it records correction history. A later fixture snapshot contains that feedback, while the repeated fixture keeps its original output. This is not model learning or a corrected model answer.

Accepting or editing appends a human review and preserves the original output. **Use reviewed draft** copies an approved draft into the composer only. **Record simulated reply** is a separate explicit action. Neither review nor draft reuse sends a message or changes case status.

## Reset and persistence

The recognized demo database is `data/supportops.sqlite` under this project. Stop the server before reset. The reset clears local cases, activities, links, diagnostics, knowledge entries, analyses, reviews, and mutation receipts, then restores the synthetic baseline:

```sh
npm run demo:reset -- --confirm
```

Reset requires the confirmation flag and refuses custom database paths, symlinked data directories, and symlinked database files. It permanently removes local demo changes in the recognized database. Browser tests use separate temporary databases.

Normal server stop/start does not reset the database. M5's restart check uses `npm start` against the same disposable file without invoking reset; see [M5 verification](M5_VERIFICATION.md).

## Verification commands

```sh
npm test
npm run test:e2e
npm run build
```

`npm run test:e2e` builds the production client and runs Chromium workflows. Each M5 A/B/C browser journey creates a fresh synthetic SQLite database and browser context. CI uses fixtures and deterministic provider doubles; it never requires an API key or paid inference. The [human acceptance guide](ACCEPTANCE.md) describes the corresponding manual steps and expected saved records.
