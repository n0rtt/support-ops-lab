# Support Engineering Workbench

**Status: M2 manual support workflow implementation; independent review and Product Owner acceptance are pending.**

M1 provides three synthetic initial reports, SQLite persistence, and transaction/idempotency infrastructure. M2 adds status filtering, chronological case history, internal notes, clearly labeled simulated replies, status transitions, escalation, and resolution. The manual workflow works without AI credentials and never sends external messages. Diagnostic investigation and AI analysis remain future milestones. See [local setup and manual workflow verification](docs/SETUP.md).

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

The approved design uses JavaScript ES modules, React/Vite, Express, SQLite through node:sqlite, and an optional server-side OpenAI Responses API. The setup guide records the commands and browser checks for the current M2 implementation.

## Engineering approach

Product Owner → Technical Orchestrator → Executor → Independent Reviewer → Product Acceptance. Commits, reviews, test results, and acceptance outcomes must represent actual work.

**Privacy:** This is an independent project using synthetic data. No source code, confidential documentation, credentials, or business-specific logic from private projects is included. No affiliation with any employer or API provider is implied.
