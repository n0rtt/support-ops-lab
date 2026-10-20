# Local setup and manual workflow verification

## Requirements

- Node.js **24.15.0** and npm from that installation.
- Chromium for `npm run test:e2e` (`npx playwright install chromium`). GitHub Actions installs Chromium and its Linux dependencies automatically.

Node 24.15.0 marks `node:sqlite` as a release candidate. M1 and M2 automated checks exercise file-backed SQLite migrations and persistence; the API remains subject to Node's stability policy. See the [Node 24.15.0 SQLite documentation](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html).

## Install and run

From the repository root:

    nvm install
    nvm use
    npm ci
    npm run db:init
    npm run build
    npm start

Open <http://127.0.0.1:3000>. The queue contains three fictional cases. Select a status filter, open a case, add an internal note, record a simulated reply, and change its status. Escalation records a reason, findings, and outstanding questions; M2 has no diagnostic evidence, so its evidence list is empty. Resolution requires an outcome and is terminal. Notes and simulated replies remain available after resolution.

Simulated replies are labeled **“Simulated reply to customer — not sent.”** The app makes no external calls and requires no AI credentials.

## Durable data and retries

SQLite stores cases, append-only activities, and mutation receipts. M2 applies numbered migrations through schema version 3: the activity sequence is backfilled in timestamp and prior insertion order, then new activities receive a per-case append sequence. The migrations preserve all existing rows and keep the same three domain tables. Case state, activity, version, and idempotency receipt commit in one transaction. Repeating the same key and payload replays its response; reusing a key for changed content or submitting against a stale case version returns a conflict.

Each browser tab saves its case drafts and exact pending requests in session storage, so reloads retain them without tabs overwriting one another. An uncertain resolution remains available for exact retry after reload, even when the case now appears resolved; its submitted outcome is distinguished from any newer unsaved draft. A newer outcome draft that remains after resolution is visible on the terminal case; it was not applied and can be reviewed or copied. A conflict never resubmits automatically; reload the current case, review the saved draft, then decide what to submit.

To check persistence manually, stop the server, run **npm run db:init**, and start the server again. Case state and history remain in the database. To restore the initial fictional cases, stop the server first and then run:

    npm run demo:reset -- --confirm

Reset clears cases, activities, and mutation receipts in this project's recognized demo database and reseeds the initial reports. It refuses to run without the confirmation flag or against a custom database path. Do not use it if you need to keep local demo data.

## Verification

Run the deterministic HTTP, database, and migration checks with:

    npm test

Run the production build and real Chromium journeys with:

    npx playwright install chromium
    npm run test:e2e

The browser suite uses a temporary SQLite database and does not touch the local demo database. It covers resolution and preserved history, an escalation with no diagnostic evidence, a filter change that keeps the selected case and draft, an interrupted save retried with the same request key, and stale conflict reconciliation.

The integration tests cover the M1 seed/config/API safeguards, schema v1-to-v3 preservation and tied-timestamp ordering, activity-based queue order, filtering and chronological detail, transition validation and current-state no-ops, required outcomes, terminal resolution, notes/replies after resolution, duplicate receipt replay, concurrent stale writes, strict Zod HTTP validation, and transaction rollback when a receipt write fails. Chromium checks cover Back/Forward, independent tab drafts, late acknowledgments and stale detail responses, current-filter queue refreshes, edits during pending saves, uncertain resolution confirmation after reload, UTC labels across browser time zones, queue priority, and the manual workflows.

## Milestone boundary

M2 contains the manual support workflow and keeps the M1 tables: **cases**, **activities**, and **mutation_receipts**. It does not include diagnostic search, evidence association, a knowledge base, AI analysis, review workflows, external messaging, authentication, or deployment.
