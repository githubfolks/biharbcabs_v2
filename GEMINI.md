# Project Rules & Architecture Directives — Extended

## 1. Architecture & Design

- **API-first architecture:** Business logic must reside in reusable backend services/API layers, not duplicated inside UI components.
- **Separation of concerns:** Keep UI, API, business/domain logic, data access, integrations, and background jobs clearly separated.
- **Multi-tenant readiness:** SaaS products should be designed with tenant isolation from the beginning, even if the first release has a single tenant.
- **Database-first thinking for business rules:** Configurable business rules, workflows, statuses, pricing, limits, templates, and feature flags should preferably be data-driven.
- **Backward compatibility:** Database/API changes must consider existing production data and clients. Prefer migrations and backward-compatible changes over destructive modifications.

## 2. AI-Assisted Development

- **AI is an accelerator, not an authority:** Never accept generated code, API behavior, architecture, or security assumptions without verification.
- **Inspect before modifying:** Before changing an existing project, understand its current architecture, dependencies, routes, database schema, environment configuration, and deployment model.
- **Minimal-change principle:** Fix the root cause with the smallest safe change; don't unnecessarily rewrite working modules.
- **No generated-code accumulation:** Remove obsolete code, duplicate utilities, dead routes, unused dependencies, and temporary debugging logic after implementation.
- **Production observability:** Important AI-generated workflows should include meaningful logging, error handling, tracing, and auditability.

## 3. Database & Data Integrity

- **Never silently lose data:** Destructive migrations, deletes, truncations, or schema changes require explicit consideration of existing production data.
- **Transactions for critical workflows:** Payments, orders, financial records, inventory movements, and other multi-step state changes must use appropriate database transactions.
- **Idempotency:** Webhooks, payment callbacks, scheduled jobs, queue consumers, and retryable operations must be safely repeatable.
- **Auditability:** Financial, administrative, security-sensitive, and important business-state changes should have an audit trail.
- **Indexes based on actual access patterns:** Don't blindly add indexes; ensure important queries are analyzed and indexed appropriately.

## 4. Security

- **Never trust client input:** Validate and authorize all externally supplied data on the server.
- **Authentication ≠ authorization:** Every protected resource must verify both identity and permission/ownership.
- **Tenant isolation is mandatory:** A tenant/user must never be able to access another tenant's data by manipulating IDs, UUIDs, query parameters, or request bodies.
- **Secrets never enter source code:** API keys, passwords, tokens, private keys, and credentials must use environment/secret-management mechanisms.
- **Sensitive information must not appear in logs:** Avoid logging passwords, tokens, payment credentials, personal secrets, or complete sensitive payloads.
- **Rate limiting and abuse protection:** Public and expensive APIs should have appropriate throttling/rate-limit mechanisms.

## 5. API & Integration Engineering

- **Contract-first mindset:** API request/response schemas should be explicit and validated.
- **Version external integrations carefully:** Pin/verify SDK/API versions where appropriate and document breaking changes.
- **External service failure is normal:** Integrations must handle timeout, retry, rate limit, authentication failure, malformed responses, and service outage scenarios.
- **Never fabricate integration success:** If an external API fails or doesn't provide required data, return an explicit failure state rather than pretending the operation succeeded.
- **Webhook processing must be idempotent and authenticated.**

## 6. Frontend

- **No business-critical authorization in frontend:** UI restrictions are for UX; backend authorization is authoritative.
- **No hardcoded production routes or IDs.**
- **Loading/error/empty states are mandatory:** Every API-driven screen should handle all three explicitly.
- **No fake UI data in production:** If backend data is unavailable, show an honest empty/error state.
- **Forms must validate at both client and server levels.**
- **Responsive production UI:** Don't treat desktop-only behavior as acceptable unless explicitly required.

## 7. Deployment & DevOps

- **Local ≈ production:** Development, staging, and production configurations should differ through configuration—not fundamentally different application behavior.
- **Environment-specific configuration must be externalized.**
- **Container reproducibility:** Docker builds should be deterministic and reproducible.
- **Health checks:** Services should expose appropriate health/readiness checks where applicable.
- **Safe deployment:** Production deployments should support rollback and database migration safety.
- **No manual undocumented production fixes:** Any production fix should eventually be represented in code/configuration/migrations.

## 8. Testing

- **Test business rules, not just endpoints.**
- **Critical workflows require integration tests.**
- **Payment/webhook/security logic requires negative-path testing.**
- **Regression tests should be added for significant bugs.**
- **Tests must use controlled test fixtures/mocks only inside the test environment.**
- **Do not declare a feature production-ready merely because the happy path works.**

## 9. Product & Business Thinking

- **Every technical decision should consider commercial impact, development cost, maintenance cost, scalability, and time-to-market.**
- **Avoid over-engineering before product-market validation.**
- **Prefer the simplest architecture that can safely support the expected business scale.**
- **Identify monetization blockers early.**
- **Separate MVP requirements from future architecture.**
- **When a requested feature has significant technical/business risk, explicitly identify it before implementation.**
- **Prioritize features that directly improve acquisition, conversion, retention, automation, or operational efficiency.**

## 10. Documentation & Decision Tracking

Important architectural decisions should be documented as **ADRs or project documentation**.

Maintain a clear record of:

- Environment variables
- Ports
- Services
- Database migrations
- External APIs
- Authentication mechanisms
- Deployment procedures
- Scheduled jobs
- Webhook endpoints
- Known limitations

**Documentation must reflect the actual implementation**, not an intended or future architecture.

## 11. Verification & Evidence Rule

> **Never declare something as working, fixed, production-ready, deployed, tested, or verified unless there is evidence.**

Examples:

- If an API wasn't actually called, don't say it works.
- If a deployment wasn't verified, don't say it is deployed.
- If a test wasn't executed, don't say tests passed.
- If an external API behavior wasn't confirmed from current documentation or an actual response, mark it **unverified**.
- Clearly distinguish between **implemented**, **tested**, **verified**, and **assumed** states.

## 12. Recommended AI Agent Behavior

When working on any project:

1. Inspect the existing implementation before making changes.
2. Identify dependencies and integration points.
3. Verify third-party APIs against the latest official documentation.
4. State important assumptions explicitly.
5. Flag technical or business risks immediately.
6. Make the smallest safe change that solves the actual problem.
7. Run appropriate tests after changes.
8. Verify the resulting behavior rather than assuming success.
9. Clean up temporary/debugging code.
10. Report exactly what was changed, what was tested, and what remains unverified.

## 13. Core Engineering Principle

> **Build for production, verify with evidence, fail honestly, protect data, and optimize for business value.**

Technical elegance is valuable, but **reliability, security, maintainability, execution speed, and commercial viability take priority.**
