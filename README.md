# Support Engineering Workbench

**Status: planning approved; implementation not started.**

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

## Intended implementation

JavaScript ES modules; React/Vite; Express; SQLite via `node:sqlite`; optional server-side OpenAI Responses API. This is a **plan**, not a description of implemented features. Actual setup commands, screenshots, tests, and CI evidence will be added after implementation and verification.

## Engineering approach

Product Owner → Technical Orchestrator → Executor → Independent Reviewer → Product Acceptance. Commits, reviews, test results, and acceptance outcomes must represent actual work.

**Privacy:** This is an independent project using synthetic data. No source code, confidential documentation, credentials, or business-specific logic from private projects is included. No affiliation with any employer or API provider is implied.
