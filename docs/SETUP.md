# Local setup and M1 verification

## Requirements

- Node.js **24.15.0**. The project pins this in .nvmrc and rejects a different Node version during npm install.
- npm from that Node installation.

Node 24.15.0 marks node:sqlite as a release candidate. M1 verifies the pinned runtime and file-backed SQLite behavior in the automated test suite; the API remains subject to Node's stability policy. See the [Node 24.15.0 SQLite documentation](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html).

## Install and run

From the repository root:

    nvm install
    nvm use
    npm ci
    npm run db:init
    npm run build
    npm start

Open <http://127.0.0.1:3000>. The M1 interface lists three fictional cases and their simulated initial reports. It is read-only and requires no API credentials. Stop the server with Ctrl-C.

Run the deterministic checks with:

    npm test

The tests use temporary SQLite files. They cover schema/seed initialization, preservation across reinitialization and process-style reopen, transaction rollback, durable receipt replay, key/payload collisions, stale versions, explicit change/no-op version progression, reset path protection including dangling symlinks, and the read-only case API.

Mutation callbacks return `{ changed, response }`. A change must advance the case version exactly once; a no-op must leave the version unchanged and perform no database writes. The helper rejects violations inside the transaction, so domain writes and receipts roll back together.

## Persistence and reset

The demo database is created at **data/supportops.sqlite**, which is ignored by Git. To check persistence manually, stop the server, run **npm run db:init**, start the server, stop it, and start it again. Case records and initial reports remain in the database.

To restore the three initial fictional cases, first stop the server and then run:

    npm run demo:reset -- --confirm

Reset clears the demo cases, activities, and mutation receipts in the project's recognized database and reseeds the initial reports. It refuses to run without the confirmation flag and cannot be pointed at a custom database path. Do not use it if you need to keep local demo data.

## M1 boundary

M1 includes only the React/Vite shell, a read-only Express case API, the **cases**, **activities**, and **mutation_receipts** tables, initial reports, and transaction/idempotency infrastructure. Diagnostics, operator actions, AI analysis, customer messaging, authentication, and deployment are later or out of scope.
