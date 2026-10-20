# Human acceptance guide

Use this guide with the local app at <http://127.0.0.1:3000>. No API key is needed. Each scenario starts from the original synthetic data and a fresh browser context so drafts from a prior scenario cannot affect it.

## Before each scenario

1. Close the browser context or private window.
2. Stop the server.
3. From the repository root, run `npm run demo:reset -- --confirm`.
4. Start the server with `npm start` and open a new private window/context.

Reset removes local changes in this project's recognized demo database. It must run while the server is stopped. If `data/supportops.sqlite` contains work you need, do not reset it; use a disposable checkout instead.

## A — Incorrect outage recommendation

### Actions

1. Open `SEW-1001`. Confirm three linked rows, `DIAG-AUTH-401-001` through `DIAG-AUTH-401-003`, each show HTTP 401.
2. Open `KB-AUTH-01`. Read the guidance that a 401 indicates an authorization failure for the observed request and repeated 401s alone do not establish an outage.
3. Choose **Load evaluation fixture**. Confirm its source is labeled **Synthetic evaluation fixture · intentionally incorrect** and its hypothesis says the provider is likely experiencing an outage.
4. Open **Inspect saved context**. Check the three diagnostic IDs and knowledge allowlist. Open the supplied diagnostic and knowledge references and inspect their details.
5. In **Reason or corrective feedback**, record that the three supplied 401s point to rejected authentication, do not establish an outage, and require checking the configured key and scopes. Choose **Reject recommendation and record correction**.
6. Load the evaluation fixture again. Open the second analysis's saved context and find the correction. The repeated fixture should still show its original outage conclusion; the fixture does not learn from the correction.
7. Choose **Edit draft and approve** on the second analysis. Set its classification to Authentication; describe all three 401 observations; keep their diagnostic references; describe rejected authentication as the likely explanation; refer to the authentication guidance; and write concrete key/scope checks, a truthful customer response, and remaining uncertainty. Choose **Save edited recommendation as approved**.
8. Choose **Use reviewed draft**. Confirm it fills the reply composer but does not add a case-history entry or change status.
9. Choose **Record simulated reply** separately. Confirm the activity is labeled as simulated and not sent.
10. Set the case to Resolved and enter an honest outcome, for example: “Completed this demonstration investigation and recorded authentication guidance. The customer credential change and service restoration remain unverified.” Save the status and history.
11. Refresh and reopen `SEW-1001`. Inspect both analyses, both review decisions, the simulated reply, the resolution outcome, and the original outage recommendation.

### Expected saved changes

- The first analysis retains its original outage conclusion and a rejected review containing the correction.
- The later analysis retains the same fixture output, captures the correction in its saved context, and has an edited human-approved recommendation with supplied references.
- Reusing the reviewed draft only fills the composer. A separate simulated-reply activity appears only after its explicit action.
- The case is Resolved with a truthful outcome that does not claim the customer's credentials were fixed or service restored.
- Refresh preserves the original output, append-only review history, reply, resolution, and chronological case activity.

### Fail if

- A fixture is presented as a genuine model error, or its repeated output appears corrected by learning.
- The original recommendation or earlier review is overwritten.
- A missing credential change, outage, or restoration is stated as verified.
- Review or draft reuse records a reply or resolves the case automatically.

### Inspect

The saved context and reference allowlist, the original analysis and review, the later analysis snapshot, the edited review, `activity-list`, the Resolved status, and its required outcome.

## B — Webhook delivery investigation

### Actions

1. Open `SEW-1002`. Confirm the evaluation fixture is disabled before evidence association.
2. Search the partial ID `evt_subscription`; confirm exact lookup returns no match. Search the exact ID `evt_subscription_480`.
3. Inspect both organizations returned. `ORG-CEDAR-02` has three subscription attempts. `ORG-MAPLE-99` has a separate history for its same-ID row; do not associate Maple's row.
4. Inspect Cedar's three attempts: HTTP 500; timeout with no HTTP response; then HTTP 204 acknowledgment with downstream processing unobserved. Select and link all three Cedar attempt rows.
5. Search `evt_invoice_731`. Inspect Cedar's HTTP 503 and pending retry. Confirm the retry has no observed delivery time or response. Select and link both rows.
6. Confirm all five Cedar records are associated and the B fixture is now available. Keep distinctive unrelated text in the reply composer as an unsent draft.
7. Load the evaluation fixture. Inspect its observations and confirm it distinguishes all five attempt results without claiming that the HTTP 204 proves processing.
8. Edit and approve the recommendation. Keep its original output visible, make the customer-response draft precise about the observed statuses and unknown downstream processing, and record the remaining uncertainty.
9. Refresh. Confirm the unsent composer text remains unchanged and the reviewed response is stored separately.
10. Set the case to Escalated. Enter a specific reason, findings, and an outstanding question about downstream processing. Select all five linked Cedar evidence IDs and save.

### Expected saved changes

- Exact global search finds the same event ID under two organizations; their histories stay separate.
- All five Cedar rows are linked to the case before the fixture loads. No Maple row is linked.
- The fixture distinguishes HTTP 500, timeout, HTTP 204 acknowledgment, HTTP 503, and pending retry. It leaves downstream processing unknown.
- The edited recommendation is appended as an approved review. The original analysis stays intact and the unsent reply draft survives review and refresh.
- The escalation records meaningful reason/findings/questions and a snapshot of all five linked Cedar IDs. It does not send or replay anything.

### Fail if

- Partial lookup acts like a match, or Cedar and Maple histories are combined.
- Any attempt is omitted from the B fixture prerequisite or escalation evidence.
- HTTP 204 is described as proof of downstream processing, or timeout/pending data is filled in as known.
- The edit overwrites the original analysis or the review replaces unsent composer text.

### Inspect

Search result organization IDs, each event's attempt history, linked evidence count/IDs, fixture output and source label, original and reviewed recommendations, retained composer text, and the escalation activity snapshot.

## C — Insufficient evidence

### Actions

1. Open `SEW-1003` and confirm no diagnostic rows are linked.
2. Search the exact ID `req_missing_case_c_20261020`. Confirm the result is empty and the interface describes missing evidence.
3. Load the C evaluation fixture. Confirm it proposes no cause and no supported diagnostic observations. Inspect the saved context: it should have no allowed diagnostic IDs and may cite `KB-REQUEST-01` for what to request.
4. Choose **Accept recommendation**, then explicitly choose **Use reviewed draft**. Confirm this only fills the composer; it does not add a history entry or change status.
5. In the composer, request one exact request ID, the affected environment, a narrow UTC time window, and sanitized error details with secrets removed. Choose **Record simulated reply** separately.
6. Set the case to Escalated. Record why request-level evidence is required, the observed empty lookup, and the outstanding identifiers/environment/time/error questions. Leave diagnostic evidence empty and save.

### Expected saved changes

- The empty search remains an honest no-result; no cause or diagnostic record is invented.
- The uncertainty fixture and accepted review persist with an empty diagnostic allowlist.
- The explicitly reused draft is only composed. The later simulated reply is a distinct history activity and requests all four items.
- Escalation records meaningful context and an empty evidence list.

### Fail if

- An empty lookup is described as a failed request or outage.
- A diagnostic, cause, or provider result is invented.
- Approval, draft reuse, or reply recording occurs implicitly.
- Escalation invents supporting evidence.

### Inspect

The search result, fixture source and uncertainty, saved-context allowlist, review record, composer before and after recording, simulated-reply activity, Escalated status, and empty evidence list.

## Browser-suite mapping

`npm run test:e2e` executes isolated Chromium versions of A, B, and C in `e2e/m5-acceptance.spec.js`; each uses a newly initialized temporary database and browser context. It also checks keyboard activation, visible focus, labels, save feedback, and narrow-width reflow. The actual `npm start` stop/start persistence check is recorded separately in [M5 verification](M5_VERIFICATION.md).
