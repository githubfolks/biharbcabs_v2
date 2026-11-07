# CLAUDE.md — Project Rules & Engineering Directives

## 1. Founder & Business Context

- Founder of **Aadikarta.org** and **AavyaLabTech**.
- 22+ years of software development experience.
- Strong full-stack engineering background with emphasis on AI-assisted development.
- Primary priorities:
  1. Commercial viability
  2. Production quality
  3. Security and reliability
  4. Fast execution
  5. Maintainability
  6. Profitability and time-to-market
- Technical decisions must consider business impact, development cost, maintenance cost, scalability, and time-to-market.
- Avoid over-engineering before product-market validation.
- Prefer the simplest architecture that can safely support the expected business scale.
- Identify technical, commercial, integration, and monetization risks early.

---

## 2. Business Accuracy — Highest Priority

**Business correctness takes priority over implementation convenience and development speed.**

- Implement the actual business requirement, not merely a technically valid approximation.
- Never infer a business rule when the requirement is ambiguous.
- Never silently change business behavior to make implementation easier.
- Never use assumptions as substitutes for missing business requirements.
- If a missing requirement can materially affect business behavior, stop and clarify or explicitly escalate the ambiguity.
- Validate calculations, workflow transitions, permissions, financial values, statuses, and business rules against authoritative requirements or source data.
- Preserve existing business behavior unless a change is explicitly requested.
- When modifying existing business logic, understand and document the current behavior before changing it.
- Test normal, boundary, and failure cases for business-critical functionality.
- Never declare business functionality correct merely because the code compiles or automated tests pass.
- **Technical correctness does not imply business correctness.**
- Never fabricate business data, calculations, workflow states, customer information, payment results, or external-service results.
- If the expected business behavior cannot be established with sufficient confidence, do not guess. Investigate or escalate.

### Priority Rule

When priorities conflict:

**Business correctness > Data integrity > Security > Production reliability > Maintainability > Development speed > Convenience**

When speed conflicts with correctness, choose correctness.

---

## 3. Non-Negotiable Engineering Rules

### No Hardcoded Production Values

- Do not hardcode business values, IDs, statuses, pricing, limits, workflow states, configuration, URLs, feature flags, or environment-specific values.
- Use database schemas, environment variables, configuration files, or APIs as appropriate.
- Never hardcode IDs in multi-step workflows or UI flows.

### Production-Ready Code

- All application code is intended for production unless explicitly identified as test-only code.
- Do not create temporary production shortcuts.
- Do not leave debugging code, temporary bypasses, commented-out obsolete implementations, or unnecessary dependencies.
- Code must include appropriate validation, error handling, logging, and security controls.

### No Synthetic or Fake Data

- Never return fake, dummy, placeholder, fabricated, or synthetic business data from production APIs.
- Never fabricate partner details, customer details, payment information, analytics, inventory, orders, astrology data, or other domain data.
- If real data is unavailable, return an honest empty/error state.
- Do not make a UI appear functional by inventing backend data.

### Mocks

- Mocks, stubs, and simulated external services are permitted only in automated tests.
- Never use mocks in production API routes or production business logic.
- Development environments must use real services where practical, or clearly isolated test infrastructure.

### Graceful Failure

- When required data or an external dependency is unavailable, fail explicitly and safely.
- Never hide errors merely to make a workflow appear successful.
- Never convert a failed operation into a fake success response.

---

## 4. Claude Coding-Agent Rules

### Inspect Before Modifying

Before changing an existing project:

1. Inspect the relevant files.
2. Understand the existing architecture.
3. Inspect related routes, services, models, schemas, and database structures.
4. Understand environment configuration and deployment assumptions.
5. Identify integration points and dependencies.
6. Determine the root cause before implementing a fix.

Do not guess the existing implementation.

### Minimal Safe Change

- Fix the root cause with the smallest safe change.
- Do not rewrite working modules unnecessarily.
- Do not modify unrelated files.
- Preserve existing functionality unless the requested change explicitly requires otherwise.
- Avoid architectural changes unless they are justified.

### Never Invent

Never assume that any of the following exists:

- Files
- Routes
- Database tables
- Columns
- APIs
- Environment variables
- Packages
- Services
- Authentication mechanisms
- External integrations
- Configuration values

Verify them before using them.

### Dependency Discipline

Before adding a dependency:

1. Check whether the project already has an equivalent capability.
2. Check compatibility with the current stack.
3. Consider maintenance and security implications.
4. Add the dependency only when justified.

---

## 5. Fact-Based Engineering & Documentation

### Third-Party APIs

- Never guess third-party API methods, parameters, request schemas, response schemas, authentication methods, SDK behavior, limits, or webhook formats.
- Verify against the **latest official documentation** before implementation.
- Prefer official documentation over blogs, outdated examples, or assumptions.
- If official documentation cannot confirm a technical detail, explicitly mark it as **unverified**.
- If a technical limitation can materially affect the project, report it immediately.

### Evidence Rule

**Never claim something is working, fixed, production-ready, deployed, tested, or verified unless there is evidence.**

Examples:

- If an API was not actually called, do not say it works.
- If deployment was not verified, do not say it is deployed.
- If tests were not executed, do not say they passed.
- If an external API behavior was not confirmed, mark it unverified.
- Clearly distinguish between:
  - Implemented
  - Tested
  - Verified
  - Unverified
  - Assumed

---

## 6. Architecture & Design

### API-First

- Business logic belongs in reusable backend services/API layers.
- Do not duplicate business logic across frontend components.
- APIs should have explicit request and response contracts.
- Validate request and response schemas appropriately.

### Separation of Concerns

Keep the following responsibilities appropriately separated:

- UI
- API/controllers/routes
- Business/domain logic
- Data access
- External integrations
- Background jobs
- Infrastructure
- Authentication/authorization

### Configuration-Driven Architecture

Business rules should preferably be data-driven when appropriate:

- Workflow states
- Pricing
- Limits
- Templates
- Feature flags
- Business rules
- Notification settings
- Tenant configuration
- Integration configuration

### Multi-Tenant Readiness

For SaaS applications:

- Design tenant isolation from the beginning.
- Never allow one tenant to access another tenant's data.
- Tenant ownership must be enforced server-side.
- Never rely only on frontend filtering for tenant isolation.

### Backward Compatibility

- Consider existing production data and clients before changing APIs or schemas.
- Prefer migrations and backward-compatible changes.
- Do not make destructive schema changes without understanding production impact.

---

## 7. PostgreSQL & Database Rules

### PostgreSQL Infrastructure

- PostgreSQL runs **natively on the local Mac host OS**.
- PostgreSQL runs **natively on the remote VPS host OS**.
- PostgreSQL is **not** running inside Docker unless explicitly changed for a specific project.
- Database connection tooling must connect to the native PostgreSQL instance.

### Data Integrity

- Never silently lose data.
- Treat destructive migrations, deletes, truncations, and schema changes as high-risk operations.
- Inspect the existing schema before modifying it.
- Follow the project's established migration strategy.

### Transactions

Use appropriate database transactions for critical multi-step operations, including:

- Payments
- Orders
- Financial records
- Inventory movements
- Account changes
- Important workflow state changes

### Idempotency

Operations that may be retried must be safely repeatable where appropriate:

- Webhooks
- Payment callbacks
- Scheduled jobs
- Queue consumers
- External integration callbacks
- Background processing

### Auditability

Important state changes should be auditable where appropriate, especially:

- Financial changes
- Administrative actions
- Security-sensitive operations
- Payment events
- Important business workflow transitions

### Database Performance

- Do not blindly add indexes.
- Analyze actual query/access patterns.
- Add indexes where they materially improve important workloads.
- Avoid unnecessary database queries and N+1 query patterns.

---

## 8. Security Rules

### Never Trust Client Input

- All externally supplied data must be validated server-side.
- Never trust client-provided amounts, statuses, permissions, IDs, roles, or ownership claims.

### Authentication vs Authorization

- Authentication confirms identity.
- Authorization confirms permission.
- Protected resources must enforce both where applicable.

### Public Resource IDs

- Never expose sequential integer database primary keys through public APIs or URLs.
- Public resources must use cryptographically unguessable UUIDs, references, or secure tokens.
- Examples include:
  - UUID
  - `order_reference`
  - Secure public token

### Tenant Isolation

A user or tenant must never access another tenant's data by manipulating:

- IDs
- UUIDs
- Query parameters
- Request bodies
- Headers
- URLs

Authorization must be enforced server-side.

### Secrets

Never commit or hardcode:

- API keys
- Passwords
- Tokens
- Private keys
- Database credentials
- Payment credentials
- OAuth secrets

Use environment variables or appropriate secret-management mechanisms.

### Sensitive Logging

Never log:

- Passwords
- Access tokens
- API secrets
- Payment credentials
- Private keys
- Sensitive personal information
- Complete sensitive payloads unless explicitly required and properly protected

### Rate Limiting

Public, expensive, authentication-related, and abuse-prone APIs should use appropriate rate limiting or throttling.

---

## 9. Payment Security

Payment systems require server-side authority.

### Razorpay / Payment Rules

- Never trust client-passed payment status.
- Never trust client-passed payment currency.
- Never trust client-passed payment amounts.
- Calculate expected payment amounts **100% server-side**.
- Validate payment callbacks/webhooks using the required cryptographic signature.
- Razorpay webhook processing must verify the `X-Razorpay-Signature` HMAC before executing business logic.
- Payment webhook handlers must be idempotent.
- Never mark a payment successful solely because the frontend reports success.
- Record appropriate payment/audit information for important payment events.

---

## 10. Admin & Privileged APIs

- Admin, analytics, telemetry, financial, operational, and privileged endpoints must enforce explicit authentication and authorization.
- Where the project uses FastAPI dependencies, use the appropriate admin guard such as:

```python
Depends(get_current_admin)
```

- Never rely solely on frontend route protection.
- Never expose privileged data through an unprotected endpoint.

---

## 11. Dynamic Workflow Integrity

- Never hardcode IDs in multi-step UI or API workflows.
- Do not fabricate required entities or partner information.
- Every required entity must be:
  1. Collected
  2. Passed
  3. Validated
  4. Persisted where appropriate
  5. Used consistently end-to-end

For example, if a workflow requires Partner 1 and Partner 2, both must be collected and validated rather than being implicitly assumed.

---

## 12. API & External Integration Engineering

### Integration Failures

External services can fail.

Handle appropriately:

- Timeout
- Rate limiting
- Authentication failure
- Invalid response
- Network failure
- Service outage
- API version changes
- Malformed data

### Never Fabricate Integration Success

If an external API fails:

- Return an explicit failure state.
- Preserve useful error information safely.
- Do not pretend the operation succeeded.
- Do not insert fake data as a fallback.

### Webhooks

Webhook handlers must:

- Authenticate the webhook.
- Validate payloads.
- Be idempotent.
- Handle duplicate delivery.
- Handle malformed requests.
- Avoid trusting client-controlled business state.

---

## 13. Frontend Rules

### Backend Authority

- Frontend restrictions are for UX only.
- Security and authorization must be enforced by the backend.

### API-Driven UI

Every API-driven screen should explicitly handle:

- Loading state
- Success state
- Empty state
- Error state

### No Fake UI Data

- Do not use fake production data to make screens appear populated.
- Empty data should display an honest empty state.

### Forms

- Validate important data on both client and server.
- Never rely only on client-side validation.

### Routes & Links

Every URL rendered by the UI or returned by an API must point to an active, verified route.

Never generate:

- Broken links
- Placeholder routes
- Imaginary API endpoints
- URLs that are not supported by the application

### Responsive Design

Production interfaces should be responsive unless the project explicitly requires a fixed environment.

---

## 14. Docker, VPS & Infrastructure

### Local and Remote Alignment

- Application and microservices run in Docker locally.
- Remote VPS mirrors the local Docker setup where practical.
- Docker container port mappings should remain aligned between local and VPS environments unless there is an explicit reason to differ.
- PostgreSQL remains native to the host OS unless explicitly changed.

### Environment Configuration

Environment-specific values must not be hardcoded.

Use appropriate configuration for:

- Database connections
- API keys
- URLs
- Ports
- Service endpoints
- Feature flags
- Secrets

### Reproducible Containers

- Docker builds should be reproducible.
- Avoid unnecessary mutable dependencies.
- Keep Docker images reasonably minimal and secure.

### Health Checks

Where appropriate, services should provide:

- Health checks
- Readiness checks
- Dependency checks

### Deployment

Production deployments should consider:

- Rollback
- Database migration safety
- Configuration validation
- Service health
- Backward compatibility

### Production Fixes

Do not make undocumented manual production fixes.

A production fix should ultimately be represented in:

- Source code
- Configuration
- Database migration
- Infrastructure configuration
- Documented operational procedure

---

## 15. QA & Testing

### Testing Strategy

Use a strong QA strategy involving:

- Unit tests
- Integration tests
- API tests
- Automated regression tests
- Simulators where appropriate
- Realistic environment mimics
- End-to-end tests for critical workflows

### Test Business Rules

Do not test only HTTP status codes.

Test:

- Business rules
- Authorization
- Validation
- Database behavior
- Payment logic
- Webhook behavior
- Failure paths
- Edge cases

### Security Testing

Critical security-related functionality should include negative-path testing.

Examples:

- Unauthorized access
- Cross-tenant access
- Invalid signatures
- Invalid amounts
- Invalid IDs
- Expired tokens
- Duplicate webhooks

### Regression Tests

When fixing a significant bug:

1. Reproduce the bug.
2. Implement the fix.
3. Add a regression test where practical.
4. Run the relevant test suite.

### Test Claims

Never say tests passed unless they were actually executed.

If tests cannot be executed, state:

> Tests not run — reason: [reason].

---

## 16. AI-Assisted Development

AI is an accelerator, not an authority.

### Required Behavior

- Verify generated code.
- Verify API behavior.
- Verify security assumptions.
- Verify architecture assumptions.
- Verify database assumptions.
- Verify package behavior.

### Before Coding

Determine:

- Existing implementation
- Root cause
- Required change
- Dependencies
- Risks
- Expected behavior
- Relevant tests

### After Coding

Perform appropriate:

- Tests
- Type checks
- Linting
- Build checks
- Runtime verification
- Integration verification

### Clean Up

Remove:

- Debugging statements
- Temporary files
- Temporary bypasses
- Dead code
- Unused imports
- Unused dependencies
- Obsolete implementations

---

## 17. Shell & Tool Usage

### Keep Tool Calls Concise

Do not pass large text blocks, multiline scripts, or raw file contents directly inside shell commands.

Avoid patterns such as:

```bash
python3 -c "very large script..."
```

or large heredocs containing substantial source code.

Instead:

1. Create a scratch/helper file using appropriate file tools.
2. Execute the file.
3. Remove temporary files when no longer required.

This keeps:

- UI prompts clean
- Confirmation dialogs manageable
- Logs readable
- Tool calls easier to audit

---

## 18. Documentation & Decision Tracking

Important architectural decisions should be documented.

Maintain documentation for:

- Architecture
- Database schema
- Environment variables
- Ports
- Services
- External APIs
- Authentication
- Authorization
- Deployment
- Scheduled jobs
- Webhooks
- Database migrations
- Known limitations
- Important business rules

### Documentation Accuracy

Documentation must reflect the **actual implementation**.

Do not document an intended architecture as though it already exists.

---

## 19. Commercial & Product Priorities

Every feature should be evaluated from both technical and business perspectives.

Consider:

- Revenue potential
- Customer value
- Acquisition
- Conversion
- Retention
- Automation
- Operational efficiency
- Development cost
- Maintenance cost
- Infrastructure cost
- Scalability
- Time-to-market

### MVP Discipline

- Clearly distinguish MVP requirements from future enhancements.
- Avoid building unnecessary complexity before validating the business need.
- Prefer commercially useful functionality over technically impressive but unnecessary features.

### Risk Escalation

Immediately flag risks involving:

- API limitations
- Vendor dependencies
- Security
- Payment systems
- Scalability
- Data integrity
- Infrastructure
- Legal/compliance implications
- Unexpected development cost
- Business model limitations

Do not silently work around a risk that could materially affect the product.

---

## 20. Change Reporting

After making significant changes, report clearly:

### Changed

What was actually modified.

### Tested

What tests/checks were actually executed.

### Verified

What behavior was actually confirmed.

### Unverified

What could not be verified and why.

### Risks

Any remaining technical or business risks.

Do not report work as complete when important verification remains outstanding.

---

## 21. Core Operating Principles

1. **Business correctness comes first.**
2. Build for production.
3. Verify with evidence.
4. Never guess when verification is possible.
5. Never fabricate data or success.
6. Protect data and secrets.
7. Treat the backend as the security authority.
8. Keep configuration dynamic.
9. Preserve existing functionality.
10. Make the smallest safe change.
11. Test critical business workflows.
12. Escalate material risks immediately.
13. Keep documentation synchronized with reality.
14. Fail honestly rather than appearing successful.
15. Optimize for business value and time-to-market.

> **The objective is not merely to produce working code. The objective is to produce correct, secure, production-ready software that implements the intended business behavior.**