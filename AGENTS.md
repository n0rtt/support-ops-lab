# Support Engineering Workbench

This repository is an independent public portfolio project with fictional support cases and read-only API/webhook diagnostics.

- Read `docs/PRODUCT_BRIEF.md` and `docs/TECHNICAL_PLAN.md` before work. Product Brief v1.0 and Technical Plan v1.1 are the Product Owner-approved baseline. The brief's original planning-only instruction has been satisfied by the subsequent approval recorded in the plan.
- Follow the assigned milestone only. Bootstrap authorizes documentation and preparation, not application implementation. Start application work only from the published baseline with an explicit milestone assignment.
- Keep React/Vite, Express, SQLite through `node:sqlite`, and the proposed server-side OpenAI integration. Escalate a significant architectural blocker to the Product Owner instead of silently changing the design.
- M1 permits only the working foundation, three synthetic cases/initial reports, minimum durable state (`cases`, `activities`, `mutation_receipts`), transaction/idempotency infrastructure, tests, CI, and setup documentation. Introduce diagnostics/association/KB tables in M3 and analysis/review tables in M4; do not preimplement later milestones.
- Author project files and synthetic data independently. Do not copy GhostPilot source, internal documentation, credentials, workflows, prompts, infrastructure, or business-specific implementation details.
- All communications are simulated. Diagnostics cannot trigger deliveries or external mutations. AI output requires human review; preserve original recommendations and append-only review history. Validate references against supplied context, keep live/fixture sources explicit, and preserve no-key operation.
- Keep credentials server-side and outside Git, client assets, and logs. Use bound SQL parameters, input validation, atomic writes, and version/idempotency checks. Validate the pinned Node runtime and SQLite persistence during M1.
- Executors implement one bounded task in an isolated branch/worktree. A different reviewer independently reviews it; self-review is not independent approval. Reviewer approval does not replace CI or Product Owner acceptance.
- Report exact commits, genuine PR/review links, commands and results, and actual CI evidence. Do not invent development history, passing checks, screenshots, live inference, or acceptance. Address review findings before integration and the next milestone.
- Prefer the smallest complete change. Add only dependencies and abstractions required by the approved journey; no agent framework, distributed queue, production authentication, or hosting requirement.
