# Support Engineering Workbench

**Status: This branch implements Product Owner-authorized M4 from approved M3 integration SHA `02c22bb11e5e2e2ae177507f26c16e5275b6eee2`. M4 acceptance and merge remain pending.**

This public portfolio project is a local-first workbench for fictional API integration support cases. M1 provides the working foundation and synthetic reports. M2 adds the manual support workflow. M3 adds exact diagnostic lookup, explicit evidence association, event-attempt inspection, and four read-only knowledge entries. M4 adds optional server-side AI analysis, offline evaluation fixtures, saved-context reference validation, and append-only human review. Existing manual and diagnostic workflows and the fixtures work without an API key.

## Manual investigation walkthrough

1. Open a case and review its report, activity history, organization, and current status.
2. In case A (`SEW-1001`), inspect the three linked synthetic HTTP 401 records and the authentication guidance in `KB-AUTH-01`. These observations support an authentication investigation; they do not establish a provider-wide outage.
3. In case B (`SEW-1002`), search exact event IDs such as `evt_subscription_480` or `evt_invoice_731`. Inspect the complete attempts, select only records belonging to `ORG-CEDAR-02`, associate them explicitly, and include already-associated rows in an escalation when useful.
4. In case C (`SEW-1003`), search for a request identifier. An empty result is shown as missing evidence, not as a fabricated failure. Ask for identifiers or escalate with an empty evidence list.
5. Load an offline AI evaluation, inspect the saved context and supplied-reference checks, then accept, edit, or reject the recommendation. Scenario A intentionally contains an incorrect outage conclusion despite citing supplied 401 evidence; it is a synthetic evaluation fixture, not an observed OpenAI model failure. Record the authentication correction and reanalyze to see the feedback in the new snapshot.
6. An approved draft can be placed in the reply composer with **Use reviewed draft**. This preserves existing unsent text unless you choose to replace it. **Record simulated reply** remains separate and creates an activity only after explicit action; review does not send a message or change case status.

Diagnostic lookup is global and case-sensitive after trimming surrounding whitespace. Identical event IDs from different organizations remain separate histories, and association is restricted to the case’s organization. A 2xx response means the endpoint acknowledged the HTTP request; downstream processing is not observed. Timeout and pending rows keep missing response and timestamp values unknown.

All communications remain simulated. Diagnostics are read-only; the workbench does not send, replay, or mutate external requests. See [local setup and demo identifiers](docs/SETUP.md) for commands and the complete fixture map.

## Project documents

- [Approved Product Brief v1.0](docs/PRODUCT_BRIEF.md)
- [Technical Plan v1.1](docs/TECHNICAL_PLAN.md)
- [Agent workflow rules](AGENTS.md)

## Architecture

The approved design uses JavaScript ES modules, React/Vite, Express, SQLite through `node:sqlite`, and the OpenAI Responses API. The pinned OpenAI SDK and shared Zod contract support optional live analysis, with `gpt-6.1-sol` as the default and `OPENAI_MODEL` configurable in the server environment. No model fallback is performed. The server uses `store: false`, no tools, disabled SDK retries, and saved-context evidence allowlists. Offline evaluations make no provider request and do not fabricate provider metadata. See [local setup and demo identifiers](docs/SETUP.md) for optional live configuration, limitations, and verification commands.

This is an independently authored project using fictional data. It contains no private-project source, internal documentation, credentials, or business-specific implementation details and implies no affiliation with an employer or API provider.
