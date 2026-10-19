# Support Engineering Workbench

**Status: M1 working foundation.**

M1 provides a read-only case queue, three synthetic initial reports, SQLite persistence, and transaction/idempotency infrastructure. It does not include case-editing workflows, diagnostics, AI analysis, or external messaging. See [local setup and M1 verification](docs/SETUP.md).

A public portfolio project demonstrating a local-first technical support workbench for investigating fictional SaaS API integration issues, inspecting diagnostic evidence, and reviewing AI-assisted recommendations before a human records an outcome.

## Planned investigation walkthrough

1. Inspect a reported integration failure and its conversation history.
2. Search API requests and webhook delivery attempts by request or event ID.
3. Separate observed facts from AI-generated hypotheses and response drafts.
4. Accept, edit, or reject an AI recommendation; record simulated communication or escalate.
5. Review preserved decision history and evaluation feedback.

Three reproducible synthetic scenarios: authentication errors incorrectly labeled as an outage, incomplete webhook delivery, and insufficient technical evidence. No real customer data, external messaging, or payment operations are involved.

## Planning documents

- [Approved Product Brief v1.0](docs/PRODUCT_BRIEF.md)
- [Technical Plan v1.1](docs/TECHNICAL_PLAN.md)
- [Agent workflow rules](AGENTS.md)

## Approved architecture

The approved design uses JavaScript ES modules, React/Vite, Express, SQLite through node:sqlite, and an optional server-side OpenAI Responses API. The setup guide records the commands verified for the current M1 implementation.

## Engineering approach

Product Owner → Technical Orchestrator → Executor → Independent Reviewer → Product Acceptance. Commits, reviews, test results, and acceptance outcomes must represent actual work.

**Privacy:** This is an independent project using synthetic data. No source code, confidential documentation, credentials, or business-specific logic from private projects is included. No affiliation with any employer or API provider is implied.
