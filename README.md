# Support Engineering Workbench

**Status: M3 implementation passed independent technical review at `68c6a0c4934c2a4466a3059b862b66b1dd0bab8c`. Product Owner acceptance, merge authorization, and integrated CI are pending.**

This public portfolio project is a local-first workbench for fictional API integration support cases. M1 provides the working foundation and synthetic reports. M2 adds the manual support workflow. The M3 branch adds exact diagnostic lookup, explicit evidence association, event-attempt inspection, and four read-only knowledge entries. No AI credentials or external services are required.

## Manual investigation walkthrough

1. Open a case and review its report, activity history, organization, and current status.
2. In case A (`SEW-1001`), inspect the three linked synthetic HTTP 401 records and the authentication guidance in `KB-AUTH-01`. These observations support an authentication investigation; they do not establish a provider-wide outage.
3. In case B (`SEW-1002`), search exact event IDs such as `evt_subscription_480` or `evt_invoice_731`. Inspect the complete attempts, select only records belonging to `ORG-CEDAR-02`, associate them explicitly, and include already-associated rows in an escalation when useful.
4. In case C (`SEW-1003`), search for a request identifier. An empty result is shown as missing evidence, not as a fabricated failure. Ask for identifiers or escalate with an empty evidence list.

Diagnostic lookup is global and case-sensitive after trimming surrounding whitespace. Identical event IDs from different organizations remain separate histories, and association is restricted to the case’s organization. A 2xx response means the endpoint acknowledged the HTTP request; downstream processing is not observed. Timeout and pending rows keep missing response and timestamp values unknown.

All communications remain simulated. Diagnostics are read-only; the workbench does not send, replay, or mutate external requests. See [local setup and demo identifiers](docs/SETUP.md) for commands and the complete fixture map.

## Project documents

- [Approved Product Brief v1.0](docs/PRODUCT_BRIEF.md)
- [Technical Plan v1.1](docs/TECHNICAL_PLAN.md)
- [Agent workflow rules](AGENTS.md)

## Architecture

The approved design uses JavaScript ES modules, React/Vite, Express, SQLite through `node:sqlite`, and an optional server-side OpenAI Responses API for a later milestone. The implementation uses no new dependencies for M3. Credentials remain server-side; M3 does not call an AI provider.

This is an independently authored project using fictional data. It contains no private-project source, internal documentation, credentials, or business-specific implementation details and implies no affiliation with an employer or API provider.
