# Support Engineering Workbench

**Product Brief & Acceptance Criteria — v1.0**

**Status:** Product requirements approved for technical planning  
**Project type:** Public GitHub portfolio project  
**Primary audience:** Technical Support Engineers working with SaaS API integrations  
**Secondary audience:** Engineering teams evaluating AI-assisted software delivery  
**Development methodology:** Product Owner → Technical Orchestrator → Executor → Independent Reviewer → Product Acceptance

---

## 1. Product Vision

Support Engineering Workbench is a small, self-contained application that helps technical support engineers investigate API integration issues, prepare accurate customer responses with AI assistance, and track the quality of AI-generated recommendations.

The application should demonstrate a realistic technical support workflow, not attempt to replace an enterprise helpdesk platform.

### Core problem

When a customer reports that an API integration is malfunctioning, support engineers often need to:

- Understand the customer's issue and previous interactions.
- Find relevant API requests or webhook delivery attempts.
- Separate verified technical facts from assumptions.
- Identify a likely cause or the next diagnostic step.
- Explain the issue clearly to the customer.
- Escalate unresolved problems to engineering.
- Track cases where an AI assistant made an incorrect recommendation.

These activities often require switching between disconnected tools.

### Proposed solution

Provide one workspace where an engineer can:

1. Review and manage incoming support cases.
2. Inspect relevant API and webhook diagnostics.
3. Ask AI to analyze the available evidence and suggest next steps.
4. Review, edit, accept, or reject AI recommendations.
5. Record the outcome, customer communication, and escalation history.
6. Review previous AI mistakes to understand where assistance failed.

### Product principle

**AI assists with diagnosis and communication; humans retain authority over customer-facing responses and operational decisions.**

---

## 2. MVP Goals

The MVP must demonstrate three capabilities.

### G1 — Support case management

A support engineer can manage a small queue of customer issues, inspect their context, track progress, and record the outcome.

### G2 — API troubleshooting

The engineer can correlate a support case with technical evidence, including API requests and webhook events, and determine what happened.

### G3 — AI-assisted support with human verification

The engineer can generate an AI recommendation grounded in case context, review it before use, and record whether it was useful or incorrect.

### Success definition

A reviewer unfamiliar with the application should be able to complete a realistic support investigation, using documented demo data, without developer assistance.

The reviewer should understand both the technical evidence and the role of AI in the workflow.

---

## 3. Intended Users

### Primary persona: Technical Support Engineer

Responsible for investigating customer reports, diagnosing integrations, communicating with customers, and escalating technical issues.

Needs quick access to relevant information, clear evidence, and a reliable workflow.

### Secondary persona: Support Lead / QA Reviewer

Wants to examine unresolved cases, understand why AI recommendations were rejected, and identify recurring support problems.

For the MVP, these personas can share one operator interface. Authentication and role-based access are out of scope.

---

## 4. Core Product Scope

### 4.1 Unified Support Queue

The application must provide a list of support cases.

Each case should include:

- Unique case ID.
- Customer or organization.
- Subject and issue description.
- Source channel.
- Creation and last-updated timestamps.
- Current status.
- Priority.
- Relevant request or event identifiers, if known.

Supported source channels in the MVP:

- Email.
- Telegram.
- Manual/internal.

**Important:** Channels are metadata and simulated intake sources. Real email and Telegram integrations are not required.

The operator must be able to open a case, review its history, and update its status.

Proposed statuses:

- Open.
- In progress.
- Escalated.
- Resolved.

Status transitions must be visible in the case history.

### 4.2 Case Detail and Conversation History

The case detail view must show:

- Initial customer report.
- Subsequent messages or internal notes.
- Current status and priority.
- Related technical evidence.
- AI recommendations and review decisions.
- Final resolution or escalation outcome.

The operator should be able to add an internal note and record a simulated customer reply.

Customer replies must not be sent to real external services.

### 4.3 API and Webhook Diagnostics

The application must support investigation of fictional SaaS API integrations.

The diagnostic dataset should include:

- Request ID.
- Customer/organization ID.
- Event or request type.
- HTTP status, where applicable.
- Timestamp.
- Delivery or processing status.
- Attempt number, where applicable.
- Sanitized technical error details.

The engineer must be able to:

- Search for a request or event by ID.
- View related delivery attempts.
- Distinguish successful, failed, and pending processing outcomes.
- Understand the observable reason for failure when diagnostic evidence exists.
- Associate relevant evidence with a support case.

Technical events should be searchable even if initially unlinked to a case.

**MVP boundary:** This is a read-only diagnostics workflow. Replaying actual production webhooks or mutating external customer systems is out of scope.

### 4.4 AI Troubleshooting Assistant

The operator can request an AI analysis of a support case.

The assistant should use relevant case context, available diagnostic evidence, and a small internal knowledge base.

The AI should return:

1. **Issue classification** — the suspected category.
2. **Verified observations** — facts supported by available evidence.
3. **Possible cause** — explicitly presented as a hypothesis where uncertain.
4. **Recommended next steps** — diagnostic or corrective actions.
5. **Draft customer response** — understandable, professional language.
6. **Evidence references** — identifiers of supporting events or knowledge-base entries.
7. **Uncertainty or missing information** — what cannot currently be confirmed.

The AI must not be presented as having inspected data it did not receive.

The product must not automatically mark AI-generated claims as verified.

### 4.5 Human Review of AI Recommendations

The operator must explicitly review AI output.

Supported actions:

- Accept a recommendation.
- Edit a recommendation or draft response.
- Reject a recommendation.
- Request another analysis after adding context.

A rejected recommendation must support a reason or correction.

At minimum, preserve:

- Original AI output.
- Review decision.
- Review timestamp.
- Edited or corrected content, where applicable.
- Reason for rejection, if rejected.

AI acceptance must not automatically send a customer message.

### 4.6 Escalation and Resolution

The operator can escalate a case when the available information is insufficient or engineering intervention is necessary.

An escalation should capture:

- Reason for escalation.
- Relevant technical evidence.
- Current findings.
- Outstanding questions.

A resolved case must preserve its outcome and history.

Real integrations with Linear, Jira, Slack, or other external tools are not required.

### 4.7 Knowledge Base

The MVP should include a small collection of fictional technical knowledge-base entries.

Examples:

- API authentication failures.
- Webhook retries and delivery failures.
- Request identifiers and troubleshooting.
- Distinguishing upstream outages from client-side configuration issues.

The AI assistant must be able to use relevant entries as context.

A full knowledge-base editor, retrieval platform, or document ingestion pipeline is not required.

---

## 5. Mandatory Demonstration Scenarios

The application must support three reproducible scenarios using synthetic data.

### Scenario A — Authentication failure incorrectly reported as an outage

A customer reports that an API integration stopped working.

Available evidence shows repeated `401 Unauthorized` responses.

The operator should be able to determine that the visible evidence points toward an authentication issue rather than a confirmed provider outage.

A deliberately incorrect AI recommendation should also be available in this scenario.

For example, the AI incorrectly concludes that the provider is experiencing an outage.

The operator must be able to reject this recommendation, record the correction, and prepare an appropriate customer response.

**Purpose:** Demonstrate evidence-based troubleshooting and human oversight of AI.

The incorrect AI recommendation may be supplied through an explicitly labeled evaluation fixture. The product must not falsely present it as a naturally observed live model failure.

### Scenario B — Webhook delivery failure

A customer reports missing subscription updates.

The diagnostic history shows failed webhook delivery attempts, including timestamps, HTTP responses, and retry outcomes.

The operator must be able to determine:

- Whether delivery was attempted.
- Which attempts failed or succeeded.
- Whether the available evidence confirms successful delivery.
- Whether additional action or escalation is necessary.

**Purpose:** Demonstrate understanding of API integrations, webhook delivery, and operational troubleshooting.

### Scenario C — Insufficient evidence

A customer reports an integration problem, but the available diagnostics do not establish its cause.

The AI should acknowledge uncertainty and recommend specific additional information or diagnostic steps.

The operator should be able to request more information from the customer or escalate the case.

**Purpose:** Demonstrate that the application distinguishes incomplete evidence from confirmed findings.

---

## 6. Business Rules

### BR-01 — Human approval

No AI-generated customer response may be treated as approved without explicit operator action.

### BR-02 — Evidence and hypotheses

Verified observations and inferred explanations must be distinguishable in the interface and stored output.

### BR-03 — No fabricated evidence

An AI recommendation may reference only technical evidence or knowledge-base entries actually supplied to it.

The application should validate referenced identifiers and flag unsupported references rather than presenting them as confirmed evidence.

This does not imply that the application can automatically guarantee every natural-language claim is factually correct.

### BR-04 — Preserved review history

Editing or rejecting an AI recommendation must not erase the original recommendation or previous review decision.

### BR-05 — Case traceability

Significant case actions must be traceable through a chronological case history.

### BR-06 — Read-only diagnostics

Investigating API/webhook events must not modify those events or trigger external delivery attempts.

### BR-07 — Safe demo data

The publicly available application and repository must contain no real customer data, production credentials, or confidential operational information.

### BR-08 — Manual operation without AI

The core support workflow must remain usable when a live AI provider is unavailable.

### BR-09 — Simulated communications

Recording a customer reply in the MVP must not send a real message. Simulated actions must be clearly labeled.

### BR-10 — Data consistency

Case state, review decisions, and activity history must remain consistent after normal application restarts.

---

## 7. Functional Acceptance Criteria

The following criteria define the minimum acceptable behavior.

### AC-01 — Open the support queue

**Given** the application contains seeded support cases,  
**When** the operator opens the support queue,  
**Then** the application displays the cases with their customer, subject, channel, status, and last activity.

### AC-02 — Filter and inspect cases

**Given** cases exist in different states,  
**When** the operator filters the queue by status and opens a case,  
**Then** the corresponding case information and conversation history are displayed correctly.

### AC-03 — Update case state

**Given** a case is open,  
**When** the operator changes its status,  
**Then** the new status persists and the transition is visible in the activity history.

### AC-04 — Find a diagnostic event

**Given** a known request ID exists in the synthetic dataset,  
**When** the operator searches for that ID,  
**Then** the matching event and its technical details are displayed.

### AC-05 — Inspect webhook attempts

**Given** a webhook has multiple delivery attempts,  
**When** the operator opens its diagnostic history,  
**Then** each attempt is shown in an understandable order with its timestamp and observed outcome.

### AC-06 — Generate AI-assisted analysis

**Given** a support case has sufficient context and a live AI provider is configured,  
**When** the operator requests AI analysis,  
**Then** the application generates a structured recommendation based on the supplied case details, technical evidence, and relevant knowledge-base content.

**And** the result clearly distinguishes observations, hypotheses, next steps, and draft response.

### AC-07 — Inspect AI evidence

**Given** an AI recommendation references technical events or documentation,  
**When** the operator reviews the recommendation,  
**Then** the supporting references can be inspected.

**And** missing or unsupported references are not presented as verified.

### AC-08 — Reject an incorrect recommendation

**Given** the authentication-failure evaluation scenario contains an incorrect outage diagnosis,  
**When** the operator rejects the diagnosis and records the correction,  
**Then** the original recommendation and corrective feedback are preserved.

### AC-09 — Approve or edit a draft

**Given** the operator has an AI-generated draft,  
**When** the operator edits or accepts it,  
**Then** the reviewed version is preserved separately from the original AI output.

**And** the action does not automatically send the reply.

### AC-10 — Escalate a case

**Given** a case lacks enough information to resolve the problem,  
**When** the operator escalates it,  
**Then** the case changes to Escalated and the escalation record includes the reason and relevant context.

### AC-11 — Resolve a case

**Given** a case has been investigated,  
**When** the operator records a resolution and marks it Resolved,  
**Then** the resolution remains available alongside the complete case history.

### AC-12 — Operate without an AI key

**Given** no live AI provider is configured,  
**When** the application starts,  
**Then** the support queue, diagnostics, notes, and case management remain functional.

**And** the AI area explains that live AI analysis is unavailable.

**And** the documented incorrect-recommendation fixture remains available as an explicitly labeled evaluation demonstration.

### AC-13 — Prevent duplicate operator actions

**Given** an operator repeats or rapidly resubmits a state-changing action,  
**When** the backend processes the request,  
**Then** the application must not create contradictory case states or unintentionally duplicate the same action.

The orchestrator must specify the exact idempotency and concurrency expectations for the selected implementation.

### AC-14 — Handle service errors

**Given** an application or AI provider request fails,  
**When** the error occurs,  
**Then** the user receives a meaningful error state rather than a misleading success indication.

**And** the failure does not silently erase previously saved case information.

### AC-15 — Complete the principal workflow

**Given** a fresh application with seeded demo data,  
**When** a reviewer follows the README instructions,  
**Then** they can investigate a case, inspect technical evidence, review an AI recommendation, record a decision, and complete or escalate the case without modifying source code.

---

## 8. Non-Functional Requirements

### NFR-01 — Easy local setup

A reviewer should be able to clone the repository and run the application using documented commands and ordinary development tools.

No paid cloud infrastructure should be mandatory.

### NFR-02 — Reproducible demonstrations

The repository must include synthetic fixtures and a documented way to initialize or reset the demo environment.

### NFR-03 — Testability

Important business rules must have automated tests.

Priority areas:

- Case status transitions.
- Diagnostic lookup and correlation.
- AI response validation.
- Acceptance/rejection history.
- Missing-evidence behavior.
- Error handling.
- Persistence of operator decisions.

### NFR-04 — CI

GitHub Actions must run appropriate automated verification on pull requests.

A passing CI run must be a real result, not a decorative badge or a claim in the README.

### NFR-05 — Secure handling of credentials

If a live AI provider is supported, API credentials must remain server-side and outside version control.

Logs and user-visible errors must avoid exposing secrets.

### NFR-06 — No unnecessary production architecture

The MVP is a portfolio demonstration, not an enterprise SaaS product.

The design should prioritize clarity, correctness, maintainability, and ease of local execution over speculative scaling requirements.

### NFR-07 — Transparent limitations

The README must accurately distinguish:

- Implemented functionality.
- Simulated integrations.
- AI-powered features.
- Evaluation fixtures.
- Features intentionally outside scope.

---

## 9. AI Requirements and Evaluation

Live AI functionality is part of the intended MVP. It should perform genuine model inference when configured.

However:

- The application must run without live AI credentials.
- CI must not depend on paid model calls.
- Automated tests should use deterministic test doubles where appropriate.
- The incorrect-AI scenario must be clearly identified as a controlled evaluation fixture.
- AI output must be reviewable and must never automatically trigger an external action.

The orchestrator should propose a minimal method for evaluating AI quality.

At minimum, the design should support tracking:

- Number of reviewed recommendations.
- Accepted recommendations.
- Rejected recommendations.
- Edited recommendations.
- Reasons for rejection.

Metrics must be labeled as demonstration data when based on synthetic cases.

No production-grade analytics dashboard is required.

---

## 10. Explicitly Out of Scope

The following must not be included in the initial MVP unless approved through a separate product decision:

- Live integrations with Telegram, Gmail, Outlook, Slack, Linear, Jira, Stripe, OnlyFans, or FansAPI.
- Real customer messages or production API logs.
- Automated customer messaging.
- Autonomous AI incident resolution.
- Production webhook replay.
- Full customer authentication and role management.
- Multi-tenant SaaS architecture.
- Billing, subscriptions, or payment processing.
- Full CRM functionality.
- Advanced knowledge-base administration.
- Fine-tuning pipelines.
- Vector database infrastructure unless a compelling MVP need is demonstrated.
- Complex deployment or cloud orchestration.
- Mobile applications.
- Unrelated dashboards and reporting features.

**The application must not grow into a general-purpose helpdesk system.**

---

## 11. Privacy and Portfolio Boundaries

The application is an independent public portfolio project.

It may demonstrate general engineering patterns informed by previous experience, but it must not copy or disclose private source code, data, internal prompts, sensitive business logic, or operational infrastructure from GhostPilot.

Use fictional customer names, organizations, API events, credentials, and documentation.

The demo should be vendor-neutral. It should not imply affiliation with FansAPI or access to its private systems.

The repository must have a clean, independent Git history.

---

## 12. Development and Verification Workflow

The project will be developed using an AI-assisted engineering process with explicit separation of responsibilities.

### Product Owner

Responsible for:

- Business requirements.
- Scope and priorities.
- Product decisions.
- Acceptance criteria.
- Final approval of user-visible behavior.

### Technical Orchestrator

Responsible for:

- Reviewing the product brief.
- Identifying inconsistencies or missing requirements.
- Proposing technical architecture.
- Defining implementation milestones.
- Specifying verification requirements.
- Producing bounded implementation tasks for executor agents.

### Executor Agent

Responsible for implementing one approved task in an isolated Git branch/worktree, including relevant tests and documentation.

### Independent Reviewer Agent

Responsible for reviewing implementation against:

- The approved requirements.
- Relevant code and design constraints.
- Test evidence.
- Error handling.
- Security and reliability expectations.
- Scope boundaries.

The reviewer may request changes. A recommendation to approve does not replace automated verification or product acceptance.

### Final Product Acceptance

The Product Owner validates that the implemented system satisfies the agreed user scenarios.

Development must preserve genuine pull requests, review decisions, CI evidence, and relevant documentation. The project history should represent actual work, not reconstructed or fabricated engineering activity.

---

## 13. Implementation Constraints

The intended project scope is **a small portfolio-grade MVP**.

The orchestrator should target a small number of well-defined implementation tasks, preferably no more than four or five milestones.

A task should be independently reviewable and have clear acceptance conditions.

The orchestrator must explicitly identify opportunities to reduce complexity.

Any proposed addition must explain why it is necessary for the MVP's user journey or acceptance criteria.

The following are deliberately not prescribed in this brief:

- Frontend framework.
- Backend framework.
- Database.
- State-management library.
- AI provider and model.
- Application folder structure.
- Deployment platform.
- Exact testing tools.

These are technical design decisions for the orchestrator to propose and justify.

The final choices should align with the candidate's existing JavaScript development experience where reasonable.

---

## 14. Required Orchestrator Deliverables

**Do not implement code at this stage.**

Produce a technical planning package containing:

### A. Requirements Review

- Confirm understanding of the product.
- Identify genuine ambiguities or contradictions.
- Separate blocking questions from reasonable assumptions.
- Highlight any requirement that threatens MVP scope.

### B. Proposed Architecture

Provide a concise technical design covering:

- Frontend and backend boundaries.
- Persistence strategy.
- Core domain entities and relationships.
- Case activity/history model.
- Diagnostic event model and correlation.
- AI analysis lifecycle and review-state handling.
- API contract overview.
- Local development setup.
- Testing and CI strategy.
- Secret and configuration handling.

Explain significant tradeoffs. Avoid architecture that is unnecessarily complex for a public demonstration.

### C. User Workflow Design

Describe the main screens and the end-to-end interactions necessary to complete Scenario A, B, and C.

Do not create decorative screens without corresponding user needs.

### D. Acceptance Traceability

Map each functional acceptance criterion to:

- Proposed implementation component.
- Automated test or verification strategy.
- Manual acceptance step where necessary.

Identify criteria that require integration tests rather than unit tests alone.

### E. Implementation Roadmap

Split the MVP into a small number of bounded, sequential milestones.

Each milestone must define:

- Scope.
- Dependencies.
- Deliverables.
- Acceptance criteria.
- Required tests.
- Review risks.
- Explicit exclusions.

### F. Executor Handoff

Produce an actionable implementation brief or prompt for the first milestone, suitable for an isolated executor agent.

Do not produce prompts for later milestones that assume unapproved architecture changes.

### G. Risk Review

Identify the most important technical and product risks, including:

- AI hallucination or unsupported conclusions.
- Incorrect event correlation.
- Lost or overwritten review history.
- Duplicate or conflicting state changes.
- Leaking secrets into frontend bundles or logs.
- Scope expansion.
- An application that looks functional but is difficult to run or verify.

Recommend proportionate mitigations.

---

## 15. Product Definition of Done

The MVP is complete when:

- All three mandatory demonstration scenarios work.
- Every MVP acceptance criterion has been checked.
- Automated tests cover the important business rules.
- CI passes on the integrated revision.
- A reviewer can run the app from the README.
- At least one live AI analysis can be performed when a valid provider key is configured.
- The app remains useful without that key.
- AI mistakes can be reviewed and recorded without erasing original outputs.
- All content and demo data are safe for publication.
- The public repository accurately documents the architecture, limitations, and AI-assisted development workflow.
- The Product Owner has completed and approved the principal end-to-end scenario.

**Technical approval alone is not product acceptance.**

---

## Final Instruction to the Orchestrator

Review this brief as an approved product specification.

Your task is to design the smallest coherent technical solution that satisfies its required behavior and provides credible evidence of software engineering competence.

Prioritize correctness, clarity, observability, realistic support workflows, and reproducible verification.

Challenge unnecessary complexity, but do not silently remove or reinterpret approved business requirements.

If you identify a meaningful conflict or a requirement that cannot reasonably fit within a small MVP, raise it explicitly before producing implementation prompts.

**Return the planning package for Product Owner review. Do not create files, modify repositories, or begin implementation until the technical plan has been approved.**