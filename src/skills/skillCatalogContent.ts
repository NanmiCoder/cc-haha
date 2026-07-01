/**
 * Embedded SKILL.md bodies for the installable skill catalog.
 *
 * Content is adapted verbatim from the MIT-licensed openai/plugins repository
 * (https://github.com/openai/plugins). Each constant is the full SKILL.md for
 * one catalog entry. Companion reference files (rules/, references/) from the
 * upstream plugins are intentionally not bundled; these SKILL.md bodies are
 * usable standalone, with reduced depth where they point to those files.
 *
 * Kept in a separate module so skillCatalog.ts stays a concise registry.
 */

export const REACT_BEST_PRACTICES_SKILL = `---
name: react-best-practices
description: React and Next.js performance optimization guidelines from Vercel Engineering. This skill should be used when writing, reviewing, or refactoring React/Next.js code to ensure optimal performance patterns. Triggers on tasks involving React components, Next.js pages, data fetching, bundle optimization, or performance improvements.
metadata:
  author: vercel
  version: "1.0.0"
---

# Vercel React Best Practices

Comprehensive performance optimization guide for React and Next.js applications, maintained by Vercel. Contains 64 rules across 8 categories, prioritized by impact to guide automated refactoring and code generation.

## When to Apply

Reference these guidelines when:
- Writing new React components or Next.js pages
- Implementing data fetching (client or server-side)
- Reviewing code for performance issues
- Refactoring existing React/Next.js code
- Optimizing bundle size or load times

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Eliminating Waterfalls | CRITICAL | \`async-\` |
| 2 | Bundle Size Optimization | CRITICAL | \`bundle-\` |
| 3 | Server-Side Performance | HIGH | \`server-\` |
| 4 | Client-Side Data Fetching | MEDIUM-HIGH | \`client-\` |
| 5 | Re-render Optimization | MEDIUM | \`rerender-\` |
| 6 | Rendering Performance | MEDIUM | \`rendering-\` |
| 7 | JavaScript Performance | LOW-MEDIUM | \`js-\` |
| 8 | Advanced Patterns | LOW | \`advanced-\` |

## Quick Reference

### 1. Eliminating Waterfalls (CRITICAL)

- \`async-defer-await\` - Move await into branches where actually used
- \`async-parallel\` - Use Promise.all() for independent operations
- \`async-dependencies\` - Use better-all for partial dependencies
- \`async-api-routes\` - Start promises early, await late in API routes
- \`async-suspense-boundaries\` - Use Suspense to stream content

### 2. Bundle Size Optimization (CRITICAL)

- \`bundle-barrel-imports\` - Import directly, avoid barrel files
- \`bundle-dynamic-imports\` - Use next/dynamic for heavy components
- \`bundle-defer-third-party\` - Load analytics/logging after hydration
- \`bundle-conditional\` - Load modules only when feature is activated
- \`bundle-preload\` - Preload on hover/focus for perceived speed

### 3. Server-Side Performance (HIGH)

- \`server-auth-actions\` - Authenticate server actions like API routes
- \`server-cache-react\` - Use React.cache() for per-request deduplication
- \`server-cache-lru\` - Use LRU cache for cross-request caching
- \`server-dedup-props\` - Avoid duplicate serialization in RSC props
- \`server-hoist-static-io\` - Hoist static I/O (fonts, logos) to module level
- \`server-serialization\` - Minimize data passed to client components
- \`server-parallel-fetching\` - Restructure components to parallelize fetches
- \`server-after-nonblocking\` - Use after() for non-blocking operations

### 4. Client-Side Data Fetching (MEDIUM-HIGH)

- \`client-swr-dedup\` - Use SWR for automatic request deduplication
- \`client-event-listeners\` - Deduplicate global event listeners
- \`client-passive-event-listeners\` - Use passive listeners for scroll
- \`client-localstorage-schema\` - Version and minimize localStorage data

### 5. Re-render Optimization (MEDIUM)

- \`rerender-defer-reads\` - Don't subscribe to state only used in callbacks
- \`rerender-memo\` - Extract expensive work into memoized components
- \`rerender-memo-with-default-value\` - Hoist default non-primitive props
- \`rerender-dependencies\` - Use primitive dependencies in effects
- \`rerender-derived-state\` - Subscribe to derived booleans, not raw values
- \`rerender-derived-state-no-effect\` - Derive state during render, not effects
- \`rerender-functional-setstate\` - Use functional setState for stable callbacks
- \`rerender-lazy-state-init\` - Pass function to useState for expensive values
- \`rerender-simple-expression-in-memo\` - Avoid memo for simple primitives
- \`rerender-split-combined-hooks\` - Split hooks with independent dependencies
- \`rerender-move-effect-to-event\` - Put interaction logic in event handlers
- \`rerender-transitions\` - Use startTransition for non-urgent updates
- \`rerender-use-deferred-value\` - Defer expensive renders to keep input responsive
- \`rerender-use-ref-transient-values\` - Use refs for transient frequent values
- \`rerender-no-inline-components\` - Don't define components inside components

### 6. Rendering Performance (MEDIUM)

- \`rendering-animate-svg-wrapper\` - Animate div wrapper, not SVG element
- \`rendering-content-visibility\` - Use content-visibility for long lists
- \`rendering-hoist-jsx\` - Extract static JSX outside components
- \`rendering-svg-precision\` - Reduce SVG coordinate precision
- \`rendering-hydration-no-flicker\` - Use inline script for client-only data
- \`rendering-hydration-suppress-warning\` - Suppress expected mismatches
- \`rendering-activity\` - Use Activity component for show/hide
- \`rendering-conditional-render\` - Use ternary, not && for conditionals
- \`rendering-usetransition-loading\` - Prefer useTransition for loading state
- \`rendering-resource-hints\` - Use React DOM resource hints for preloading
- \`rendering-script-defer-async\` - Use defer or async on script tags

### 7. JavaScript Performance (LOW-MEDIUM)

- \`js-batch-dom-css\` - Group CSS changes via classes or cssText
- \`js-index-maps\` - Build Map for repeated lookups
- \`js-cache-property-access\` - Cache object properties in loops
- \`js-cache-function-results\` - Cache function results in module-level Map
- \`js-cache-storage\` - Cache localStorage/sessionStorage reads
- \`js-combine-iterations\` - Combine multiple filter/map into one loop
- \`js-length-check-first\` - Check array length before expensive comparison
- \`js-early-exit\` - Return early from functions
- \`js-hoist-regexp\` - Hoist RegExp creation outside loops
- \`js-min-max-loop\` - Use loop for min/max instead of sort
- \`js-set-map-lookups\` - Use Set/Map for O(1) lookups
- \`js-tosorted-immutable\` - Use toSorted() for immutability
- \`js-flatmap-filter\` - Use flatMap to map and filter in one pass

### 8. Advanced Patterns (LOW)

- \`advanced-event-handler-refs\` - Store event handlers in refs
- \`advanced-init-once\` - Initialize app once per app load
- \`advanced-use-latest\` - useLatest for stable callback refs

## How to Use

These quick-reference rules are self-contained guidance. The upstream plugin
ships a \`rules/\` directory and a compiled \`AGENTS.md\` with per-rule code
examples; those are not bundled here. Apply the rules above directly, and
consult the React/Next.js and Vercel documentation for detailed examples.
`

export const STRIPE_BEST_PRACTICES_SKILL = `---
name: stripe-best-practices
description: Guides Stripe integration decisions — API selection (Checkout Sessions vs PaymentIntents), Connect platform setup (Accounts v2, controller properties), billing/subscriptions, Treasury financial accounts, integration surfaces (Checkout, Payment Element), and migrating from deprecated Stripe APIs. Use when building, modifying, or reviewing any Stripe integration — including accepting payments, building marketplaces, integrating Stripe, processing payments, setting up subscriptions, or creating connected accounts.
---

Latest Stripe API version: **2026-02-25.clover**. Always use the latest API version and SDK unless the user specifies otherwise.

## Integration routing

| Building... | Recommended API | Details |
|---|---|---|
| One-time payments | Checkout Sessions | [references/payments.md](references/payments.md) |
| Custom payment form with embedded UI | Checkout Sessions + Payment Element | [references/payments.md](references/payments.md) |
| Saving a payment method for later | Setup Intents | [references/payments.md](references/payments.md) |
| Connect platform or marketplace | Accounts v2 (\`/v2/core/accounts\`) | [references/connect.md](references/connect.md) |
| Subscriptions or recurring billing | Billing APIs + Checkout Sessions | [references/billing.md](references/billing.md) |
| Embedded financial accounts / banking | v2 Financial Accounts | [references/treasury.md](references/treasury.md) |

Read the relevant reference file before answering any integration question or writing code.

## Key documentation

When the user's request does not clearly fit a single domain above, consult:

- [Integration Options](https://docs.stripe.com/payments/payment-methods/integration-options.md) — Start here when designing any integration.
- [API Tour](https://docs.stripe.com/payments-api/tour.md) — Overview of Stripe's API surface.
- [Go Live Checklist](https://docs.stripe.com/get-started/checklist/go-live.md) — Review before launching.
`

export const SUPABASE_BEST_PRACTICES_SKILL = `---
name: supabase-postgres-best-practices
description: Postgres performance optimization and best practices from Supabase. Use this skill when writing, reviewing, or optimizing Postgres queries, schema designs, or database configurations.
metadata:
  author: supabase
  version: "1.1.0"
  organization: Supabase
---

# Supabase Postgres Best Practices

Comprehensive performance optimization guide for Postgres, maintained by Supabase. Contains rules across 8 categories, prioritized by impact to guide automated query optimization and schema design.

## When to Apply

Reference these guidelines when:
- Writing SQL queries or designing schemas
- Implementing indexes or query optimization
- Reviewing database performance issues
- Configuring connection pooling or scaling
- Optimizing for Postgres-specific features
- Working with Row-Level Security (RLS)

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Query Performance | CRITICAL | \`query-\` |
| 2 | Connection Management | CRITICAL | \`conn-\` |
| 3 | Security & RLS | CRITICAL | \`security-\` |
| 4 | Schema Design | HIGH | \`schema-\` |
| 5 | Concurrency & Locking | MEDIUM-HIGH | \`lock-\` |
| 6 | Data Access Patterns | MEDIUM | \`data-\` |
| 7 | Monitoring & Diagnostics | LOW-MEDIUM | \`monitor-\` |
| 8 | Advanced Features | LOW | \`advanced-\` |

## How to Use

Read individual rule files in \`references/\` for detailed explanations and SQL
examples (incorrect vs correct, with query plans where relevant), e.g.:

\`\`\`
references/query-missing-indexes.md
references/security-rls-performance.md
references/_sections.md
\`\`\`

## References

- https://www.postgresql.org/docs/current/
- https://supabase.com/docs
- https://wiki.postgresql.org/wiki/Performance_Optimization
- https://supabase.com/docs/guides/database/overview
- https://supabase.com/docs/guides/auth/row-level-security
`

export const FRONTEND_TESTING_DEBUGGING_SKILL = `---
name: frontend-testing-debugging
description: "Use when testing, debugging, or making targeted improvements to rendered frontend apps: local dev servers, UI regressions, interaction bugs, console errors, responsive layout, and visual QA. Check whether a Browser automation tool is available and use it first when it is; otherwise use regular Playwright with the recorded reason."
---

# Frontend Testing Debugging

## Invocation Contract

This skill should work from normal user prompts. Do not require the user to spell out browser routing, screenshots, report shape, or fallback policy.

Use this skill for a rendered frontend change, test, or bug investigation.

From a brief prompt, infer the target surface from the repo, currently open app/browser URL, nearby files, or running dev server. If the target URL is unclear, inspect the repo scripts and running local ports before asking the user.

For any code change to a rendered frontend surface, do the validation loop by default:

1. Identify the target flow.
2. Choose the browser path below.
3. Make the smallest useful edit.
4. Validate the rendered behavior.
5. Reply with the QA final response report.

## Choose The Browser Path

First classify browser-automation availability:

- **Available**: a browser automation tool (e.g. a Browser MCP/skill) is listed in the session. Read and follow it before any browser action.
- **Absent**: no browser tool is listed. Use regular Playwright and record \`Browser plugin not available\`.
- **Invocation failed**: a browser tool appears available, but the runtime, tab acquisition, or navigation fails. Treat this as a browser-path blocker.

Only switch from a failed browser invocation to regular Playwright if the user already allowed fallback or the task explicitly permits non-browser validation. In that case, report the exact failure and the fallback decision.

## Target Flow

Before browser validation, define the target flow in one sentence:

\`The flow under test is: [entry route] -> [user action or state] -> [expected rendered result].\`

If the user asked for general smoke testing, use:

\`The flow under test is: app loads -> first meaningful screen renders -> primary visible controls respond without runtime errors.\`

## Required Browser Checks

Run these checks before claiming the rendered app works:

1. **Page identity**: the current URL and title match the intended page.
2. **Not blank**: a DOM snapshot contains meaningful app content, not an empty shell.
3. **No framework overlay**: the snapshot or screenshot does not show a Next.js, Vite, Webpack, or framework error overlay.
4. **Console health**: error/warn console logs have no relevant app errors, or each relevant error is explained.
5. **Screenshot evidence**: a screenshot supports visual claims.
6. **Interaction proof**: at least one target-flow interaction is exercised and followed by a state check.

For visual work, add desktop plus one mobile-sized viewport when practical. For reference-driven work, keep a short mismatch ledger: reference evidence, rendered evidence, fix or intentional deviation.

## Playwright Loop

Use this branch when no browser tool is available, or when the user has allowed fallback after a browser invocation failure.

Use this order:

1. Find scripts in \`package.json\`.
2. Start the app with the repo's package manager and keep the requested host exact.
3. Prefer the repo's e2e script if present.
4. Otherwise run \`pnpm exec playwright test\` or the package-manager equivalent when Playwright is configured.
5. If there is no project Playwright workflow, verify Playwright with \`pnpm exec playwright --version\`, then capture a screenshot with \`pnpm exec playwright screenshot <url> /tmp/frontend-check.png\`.
6. For deeper debugging, create a small temporary Playwright script outside committed source that opens the URL, captures console errors, screenshots, and runs the target interaction.
7. After edits, rerun the same command or script.

Do not install new browser dependencies unless the task requires it and the user has allowed dependency changes.

## Validation Checklist

- Keep the requested host exact.
- Verify controls update real UI state.
- Check the first viewport before scrolling, plus desktop and one mobile-sized viewport when practical.
- Look for clipping, overlap, unreadable text, wrapping, layout shift, missing assets, z-index issues, scroll traps, stale loading, and broken states.
- For reference-driven work, compare the rendered screenshot against the reference and keep a short mismatch ledger.
- A passing build is not enough when rendered validation was requested.

## QA Final Response Report

For any non-trivial rendered UI validation run, write the final response like a QA engineer verifying a code change. Use this shape:

- **Summary**: one or two bullets explaining the user-visible change and whether QA passed.
- **Environment**: URL, viewport(s), browser-tool availability classification, and fallback reason if Playwright was used.
- **Changes Verified**: files or surfaces changed, plus the specific user-facing behavior expected.
- **Checks**: a pass/fail table for page identity, blank-page check, framework overlay check, console health, screenshot evidence, and interaction proof.
- **Interaction Loop**: exact interaction path tested, including the control or workflow exercised and the observed state change.
- **Evidence**: describe the screenshot evidence, then place the actual screenshots together at the end as consecutive images.
- **Remaining Risk**: untested viewports, flows, browsers, data states, or known limitations.

If issues were found, lead with **Findings** before the summary. Each finding should include what the user sees, reproduction steps, evidence, likely owner or file when known, and the fix made or remaining blocker.

Do not create separate HTML reports by default. Only create a standalone report file when the user explicitly asks for one, and write it outside the repo unless the user explicitly asks for committed artifacts.

## Related Skills

- Use a design/app-builder skill when the task is design creation, redesign, or fidelity to an accepted concept.
- Use \`react-best-practices\` after meaningful React/Next.js component edits.
`

export const TEMPORAL_DEVELOPER_SKILL = `---
name: temporal-developer
description: Develop, debug, and manage Temporal applications across Python, TypeScript, Go, and Java. Use when the user is building workflows, activities, or workers with a Temporal SDK, debugging issues like non-determinism errors, stuck workflows, or activity retries, using Temporal CLI, Temporal Server, or Temporal Cloud, or working with durable execution concepts like signals, queries, heartbeats, versioning, continue-as-new, child workflows, or saga patterns.
---

# Skill: temporal-developer

## Overview

Temporal is a durable execution platform that makes workflows survive failures automatically. This skill provides guidance for building Temporal applications in Python, TypeScript, Go, and Java.

## Core Architecture

The **Temporal Cluster** is the central orchestration backend. It maintains three key subsystems: the **Event History** (a durable log of all workflow state), **Task Queues** (which route work to the right workers), and a **Visibility** store (for searching and listing workflows). There are three ways to run a Cluster:

- **Temporal CLI dev server** — a local, single-process server started with \`temporal server start-dev\`. Suitable for development and testing only, not production.
- **Self-hosted** — you deploy and manage the Temporal server and its dependencies (e.g., database) in your own infrastructure for production use.
- **Temporal Cloud** — a fully managed production service operated by Temporal. No cluster infrastructure to manage.

**Workers** are long-running processes that poll Task Queues for work and execute your code. Each Worker hosts two types of code:

- **Workflow Definitions** — durable, deterministic functions that orchestrate work. These must not have side effects.
- **Activity Implementations** — non-deterministic operations (API calls, file I/O, etc.) that can fail and be retried.

Workers communicate with the Cluster via a poll/complete loop: they poll a Task Queue for tasks, execute the corresponding Workflow or Activity code, and report results back.

## History Replay: Why Determinism Matters

Temporal achieves durability through **history replay**:

1. **Initial Execution** - Worker runs workflow, generates Commands, stored as Events in history
2. **Recovery** - On restart/failure, Worker re-executes workflow from beginning
3. **Matching** - SDK compares generated Commands against stored Events
4. **Restoration** - Uses stored Activity results instead of re-executing

**If Commands don't match Events = Non-determinism Error = Workflow blocked**

| Workflow Code | Command | Event |
|--------------|---------|-------|
| Execute activity | \`ScheduleActivityTask\` | \`ActivityTaskScheduled\` |
| Sleep/timer | \`StartTimer\` | \`TimerStarted\` |
| Child workflow | \`StartChildWorkflowExecution\` | \`ChildWorkflowExecutionStarted\` |

## Getting Started

### Ensure Temporal CLI is installed

Check if \`temporal\` CLI is installed. If not:

- **macOS**: \`brew install temporal\`
- **Linux / Windows**: download the latest CLI archive from https://temporal.download and add the \`temporal\` binary to your PATH.

### Durable Execution Concepts

Apply these concepts when building and debugging:

- **Signals / Queries / Updates** — interact with running workflows.
- **Heartbeats** — long activities report progress and detect cancellation.
- **Versioning** — safely change workflow code while workflows are running.
- **Continue-as-new** — reset history for long-running/looping workflows.
- **Child workflows & Saga** — compose and compensate multi-step flows.

The upstream plugin ships a \`references/\` tree with per-language (Python,
TypeScript, Go, Java) guides and detailed determinism/patterns/gotchas docs;
those files are not bundled here. Consult the Temporal documentation at
https://docs.temporal.io for language-specific implementation details.
`

// ─── Stripe reference files (bundled for the "complete" stripe skill) ──────────

export const STRIPE_REF_PAYMENTS = `# Payments

## Table of contents
- API hierarchy
- Integration surfaces
- Payment Element guidance
- Saving payment methods
- Dynamic payment methods
- Deprecated APIs and migration paths
- PCI compliance

## API hierarchy

Use the [Checkout Sessions API](https://docs.stripe.com/api/checkout/sessions.md) (\`checkout.sessions.create\`) for on-session payments. It supports one-time payments and subscriptions and handles taxes, discounts, shipping, and adaptive pricing automatically.

Use the [PaymentIntents API](https://docs.stripe.com/payments/paymentintents/lifecycle.md) for off-session payments, or when the merchant needs to model checkout state independently and just create a charge.

**Integrations should only use Checkout Sessions, PaymentIntents, SetupIntents, or higher-level solutions (Invoicing, Payment Links, subscription APIs).**

## Integration surfaces

Prioritize Stripe-hosted or embedded Checkout where possible. Use in this order of preference:

1. **Payment Links** — No-code. Best for simple products.
2. **Checkout** ([docs](https://docs.stripe.com/payments/checkout.md)) — Stripe-hosted or embedded form. Best for most web apps.
3. **Payment Element** ([docs](https://docs.stripe.com/payments/payment-element.md)) — Embedded UI component for advanced customization.
   - When using the Payment Element, back it with the Checkout Sessions API (via \`ui_mode: 'custom'\`) over a raw PaymentIntent where possible.

**Traps to avoid:** Do not recommend the legacy Card Element or the Payment Element in card-only mode. If the user asks for the Card Element, advise them to [migrate to the Payment Element](https://docs.stripe.com/payments/payment-element/migration.md).

## Payment Element guidance

For surcharging or inspecting card details before payment (e.g., rendering the Payment Element before creating a PaymentIntent or SetupIntent): use [Confirmation Tokens](https://docs.stripe.com/payments/finalize-payments-on-the-server.md). Do not recommend \`createPaymentMethod\` or \`createToken\` from Stripe.js.

## Saving payment methods

Use the [Setup Intents API](https://docs.stripe.com/api/setup_intents.md) to save a payment method for later use.

**Traps to avoid:** Do not use the Sources API to save cards to customers. The Sources API is deprecated — Setup Intents is the correct approach.

## Dynamic payment methods

Advise users to enable dynamic payment methods in the Stripe Dashboard rather than passing specific [\`payment_method_types\`](https://docs.stripe.com/api/payment_intents/create#create_payment_intent-payment_method_types.md) in the PaymentIntent or SetupIntent. Stripe automatically selects payment methods based on the customer's location, wallets, and preferences when the Payment Element is used.

## Deprecated APIs and migration paths

Never recommend the Charges API. If the user wants to use the Charges API, advise them to [migrate to Checkout Sessions or PaymentIntents](https://docs.stripe.com/payments/payment-intents/migration/charges.md).

Do not call other deprecated or outdated API endpoints unless there is a specific need and absolutely no other way.

| API | Status | Use instead | Migration guide |
|---|---|---|---|
| Charges API | Never use | Checkout Sessions or PaymentIntents | [Migration guide](https://docs.stripe.com/payments/payment-intents/migration/charges.md) |
| Sources API | Deprecated | Setup Intents | [Setup Intents docs](https://docs.stripe.com/api/setup_intents.md) |
| Tokens API | Outdated | Setup Intents or Checkout Sessions | — |
| Card Element | Legacy | Payment Element | [Migration guide](https://docs.stripe.com/payments/payment-element/migration.md) |

## PCI compliance

If a PCI-compliant user asks about sending server-side raw PAN data, advise them that they may need to prove PCI compliance to access options like [payment_method_data](https://docs.stripe.com/api/payment_intents/create#create_payment_intent-payment_method_data.md).

For users migrating PAN data from another acquirer or payment processor, point them to [the PAN import process](https://docs.stripe.com/get-started/data-migrations/pan-import.md).
`

export const STRIPE_REF_CONNECT = `# Connect / Platforms

## Table of contents
- Accounts v2 API
- Controller properties
- Charge types
- Integration guides

## Accounts v2 API

For new Connect platforms, ALWAYS use the [Accounts v2 API](https://docs.stripe.com/connect/accounts-v2.md) (\`POST /v2/core/accounts\`). This is Stripe's actively invested path and ensures long-term support.

**Traps to avoid:** Do not use the legacy \`type\` parameter (\`type: 'express'\`, \`type: 'custom'\`, \`type: 'standard'\`) in \`POST /v1/accounts\` for new platforms unless the user has explicitly requested v1.

## Controller properties

Configure connected accounts using \`controller\` properties instead of legacy account types:

| Property | Controls |
|---|---|
| \`controller.losses.payments\` | Who is liable for negative balances |
| \`controller.fees.payer\` | Who pays Stripe fees |
| \`controller.stripe_dashboard.type\` | Dashboard access (\`full\`, \`express\`, \`none\`) |
| \`controller.requirement_collection\` | Who collects onboarding requirements |

Use \`defaults.responsibilities\`, \`dashboard\`, and \`configuration\` as described in [connected account configuration](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration.md).

Always describe accounts in terms of their responsibility settings, dashboard access, and [capabilities](https://docs.stripe.com/connect/account-capabilities.md) to describe what connected accounts can do.

**Traps to avoid:** Do not use the terms "Standard", "Express", or "Custom" as account types. These are legacy categories that bundle together responsibility, dashboard, and requirement decisions into opaque labels. Controller properties give explicit control over each dimension.

## Charge types

Choose one charge type per integration — do not mix them. For most platforms, start with destination charges:

- **Destination charges** — Use when the platform accepts liability for negative balances. Funds route to the connected account via \`transfer_data.destination\`.
- **Direct charges** — Use when the platform wants Stripe to take risk on the connected account. The charge is created on the connected account directly.

Use \`on_behalf_of\` to control the merchant of record, but only after reading [how charges work in Connect](https://docs.stripe.com/connect/charges.md).

**Traps to avoid:** Do not use the Charges API for Connect fund flows — use PaymentIntents or Checkout Sessions with \`transfer_data\` or \`on_behalf_of\`. Do not mix charge types within a single integration.

## Integration guides

- [SaaS platforms and marketplaces guide](https://docs.stripe.com/connect/saas-platforms-and-marketplaces.md) — Choosing the right integration shape.
- [Interactive platform guide](https://docs.stripe.com/connect/interactive-platform-guide.md) — Step-by-step platform builder.
- [Design an integration](https://docs.stripe.com/connect/design-an-integration.md) — Detailed risk and responsibility decisions.
`

export const STRIPE_REF_BILLING = `# Billing / Subscriptions

## Table of contents
- When to use Billing APIs
- Recommended frontend pairing
- Traps to avoid

## When to use Billing APIs

If the user has a recurring revenue model (subscriptions, usage-based billing, seat-based pricing), use the Billing APIs to [plan their integration](https://docs.stripe.com/billing/subscriptions/designing-integration.md) instead of a direct PaymentIntent integration.

Review the [Subscription Use Cases](https://docs.stripe.com/billing/subscriptions/use-cases.md) and [SaaS guide](https://docs.stripe.com/saas.md) to find the right pattern for the user's pricing model.

## Recommended frontend pairing

Combine Billing APIs with Stripe Checkout for the payment frontend. Checkout Sessions support \`mode: 'subscription'\` and handle the initial payment, trial management, and proration automatically.

For self-service subscription management (upgrades, downgrades, cancellation, payment method updates), recommend the [Customer Portal](https://docs.stripe.com/customer-management/integrate-customer-portal.md).

## Traps to avoid

- Do not build manual subscription renewal loops using raw PaymentIntents. Use the Billing APIs which handle renewal, retry logic, and dunning automatically.
- Do not use the deprecated \`plan\` object. Use [Prices](https://docs.stripe.com/api/prices.md) instead.
`

export const STRIPE_REF_TREASURY = `# Treasury / Financial Accounts

## Table of contents
- v2 Financial Accounts API
- Legacy v1 Treasury

## v2 Financial Accounts API

For embedded financial accounts (bank accounts, account and routing numbers, money movement), use the [v2 Financial Accounts API](https://docs.stripe.com/api/v2/core/vault/financial-accounts.md) (\`POST /v2/core/vault/financial_accounts\`). This is required for new integrations.

For Treasury concepts and guides, see the [Treasury overview](https://docs.stripe.com/treasury.md).

## Legacy v1 Treasury

Do not use the [v1 Treasury Financial Accounts API](https://docs.stripe.com/api/treasury/financial_accounts.md) (\`POST /v1/treasury/financial_accounts\`) for new integrations. Existing v1 integrations continue to work.
`
