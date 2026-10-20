# M5 verification record

**Milestone:** M5 — Final Acceptance & Portfolio Presentation · **Approved base:** `583a864eaa3f293f5437fd3134db4361860eee85`
**Status:** Executor verification only. A different independent technical review and Product Owner acceptance remain outstanding.

## Local setup and checks

The checks below ran in the isolated M5 worktree on Node `24.15.0` and npm `11.13.0`, with `OPENAI_API_KEY` unset. They use supplied fixtures and never call a provider.

| Command | Result |
| --- | --- |
| `npm ci` | Passed; installed 93 packages, audited 94, 0 vulnerabilities. |
| `npm run db:init` | Passed; initialized the recognized demo database. |
| `npm test` | Passed; 44 tests, 0 failures. Includes SQLite, no-key, persistence, and reset-path protections. |
| `npm run test:e2e` | Passed; production build plus 29 Chromium journeys, 0 failures. |
| `npm run build` | Passed independently; Vite production build completed. |
| `npm start` without a key | Started at `127.0.0.1:3000`; `/api/config` reported `liveInferenceAvailable: false`, and manual fixture/review work remained available. |

The user-facing install sequence was exercised from the new worktree created at the approved base: pinned Node, clean `npm ci`, database initialization, build, and no-key server start. The M5 changes make no application-schema, dependency, or architecture changes.

## A/B/C browser acceptance

The four M5 E2E tests in `e2e/m5-acceptance.spec.js` each create a fresh browser context and temporary initialized SQLite database. Chromium results were also run separately: A passed (1/1), B passed (1/1), and C passed (1/1). The final combined E2E run passed all 29 tests.

- **A — Authentication:** Inspected all three linked 401 records and `KB-AUTH-01`; loaded the explicitly wrong fixture; inspected its saved context and supplied references; rejected it with a grounded correction; verified the correction in later context while the repeated fixture retained its original outage claim; edited and approved a complete grounded recommendation; explicitly reused its draft; recorded the simulated reply as a separate action; resolved with an honest outcome; and verified original output, reviews, reply, status, outcome, and history after reload.
- **B — Webhooks:** Confirmed partial exact lookup returned no match; kept Cedar and Maple's same-ID histories separate; inspected all five Cedar attempts; linked all three subscription and both invoice attempts before loading the fixture; verified 500, timeout, 204 acknowledgment, 503, and pending-retry semantics without claiming downstream processing; edited and approved the recommendation; preserved unsent reply text; and escalated with all five linked IDs and specific findings and questions.
- **C — Insufficient evidence:** Confirmed an empty exact lookup and empty diagnostic allowlist; loaded the uncertainty fixture without inventing a cause; explicitly approved and reused the recommendation; recorded a separate request for request ID, environment, narrow UTC window, and sanitized error; and escalated with meaningful findings and no evidence IDs.

Repeating a fixture provides prior correction feedback as saved context only. It does not learn from that feedback or change the fixture output.

## Persistent server restart

The M4 live `SEW-1003` analysis was not available in the local checkout: before M5, there was no `data/supportops.sqlite` file or running application process. No new paid request was made. Restart verification therefore used the disposable offline demo database at the recognized `data/supportops.sqlite` path.

After `npm run db:init` and `npm run build`, a normal `npm start` process with no API key ran the Scenario A persistence path against that file: reject, repeat the fixture, edit and approve, reuse the reviewed draft, record a simulated reply, and resolve with an honest outcome. The process was stopped with Ctrl+C and started again with `npm start`, without running reset or initialization between processes. A new Chromium context then loaded the case and checked the API and UI. Across the restart it retained:

- `SEW-1001` status `resolved`, all three linked 401 rows, and eight chronological activities;
- original incorrect fixture output in both analyses, with first review `rejected` and second review `edited`;
- analysis IDs `AN-5c2817c4-fcbd-47d4-b37d-5b533e624307` and `AN-318b6142-3042-4106-a1db-1c09e00072b9`;
- the separately recorded simulated response and the honest resolution outcome.

After confirming restart persistence, the persistent server was stopped. `npm run demo:reset -- --confirm` was run four times only while no application server was running: before the A test, between A and B, between B and C, and once at the end to leave the disposable database at its baseline. Each reset restored the synthetic baseline. The browser tests themselves used isolated temporary databases and fresh contexts. This establishes offline local persistence; restart persistence of the unavailable M4 live-specific record was not exercised.

The persistent-process check was repeated on follow-up head `215edcda4155042275940f864bfe50a77a64a32f`: after the no-key A flow, the server was stopped and restarted against the same `data/supportops.sqlite` without reset or initialization between processes. A new Chromium context and the API confirmed resolved status, both original fixture outputs and `rejected`/`edited` review decisions, all three diagnostic links, the simulated reply, the honest outcome, and eight chronological activities. Afterward the server was stopped and the disposable database reset to its synthetic baseline.

## Keyboard, readability, browser, and layout checks

- The Chromium E2E checks verify associated labels on visible form controls, a visible 3px keyboard focus outline, Enter activation of the fixture button, and visible `Saved.` status feedback. A rendered-page inspection found no unlabeled input, textarea, or select controls.
- Computed Chromium text contrast for representative visible elements: case heading `14.55:1`; activity text `9.04:1`; form label `6.62:1`; primary action button `6.05:1`. These are targeted samples, not a full accessibility audit.
- Responsive reflow had no document overflow at 1440, 720, 360, or 320 CSS-pixel viewport widths. The layout E2E opens the structured editor at 360px, verifies each supplied-reference label stays within its fieldset, repeats the containment and document-overflow checks at 320px, then saves an edited recommendation with Enter and verifies its `Edited` status. The 720px case is a 200%-zoom-equivalent viewport starting from 1440 CSS pixels; native browser zoom controls were not changed.
- A practical Firefox `155.0` smoke loaded `SEW-1001`, confirmed its three diagnostic rows and no-key fixture flow, and found no horizontal overflow at 720px. On the follow-up head, Firefox also opened the structured editor at 360px, checked reference-label containment and document overflow at 360px and 320px, and keyboard-saved an edited review with visible `Edited` feedback. The full browser suite ran in Chromium `153.0.8010.12`; Firefox did not run the full suite.

## Screenshot provenance

Both images are direct, uncropped Chromium viewport captures of the built app, browser version `153.0.8010.12`, using separate fresh browser contexts against the disposable no-key demo database. Their source revision is `be76cf733cd5507c246596136561144130222fc0`; no DOM or image edits were applied.

- [`docs/images/m5-scenario-a-evidence.png`](images/m5-scenario-a-evidence.png) is a 1000×1400 CSS-pixel viewport centered on the case's diagnostic-evidence section, with all three HTTP 401 records visible. It was captured from the resolved A case after the persistence path completed.
- [`docs/images/m5-scenario-a-human-correction.png`](images/m5-scenario-a-human-correction.png) is a 1000×1800 CSS-pixel viewport with the second fixture's review expanded. It shows the explicit intentionally-incorrect fixture label and original outage hypothesis above the saved human-edited authentication response.

To reproduce them, use the no-key setup in [SETUP](SETUP.md), complete [Scenario A](ACCEPTANCE.md), open `SEW-1001` in fresh Chromium contexts, and capture the two viewport states and dimensions described above without cropping. The committed screenshots are from the real application, not mockups.

## Historical evidence and acceptance boundary

PRs #1–#4, actual heads and integration SHAs, published review reports, Product Owner decisions, and PR/integrated-main CI runs are linked in [engineering history](ENGINEERING_HISTORY.md). The M4 accepted live-inference record remains separate from M5 local restart evidence.

The independent PR #5 review requested changes at `1beddc5275f58a7d436135fd1ccb9fb77beb02c3` for screenshot readability and framing, the structured editor at 320px, and README first-screen disclosure. The follow-up adds two larger unaltered app captures, documents their visible case context, tests the open editor at 320px, and moves the no-key/simulated boundary above the screenshots. Independent exact-head re-review remains pending.

M5 remains open for a different independent technical review. This record does not claim M5 Product Owner acceptance, merge, deployment, or MVP completion. The final M5 head and its PR CI run are reported on the open pull request.
