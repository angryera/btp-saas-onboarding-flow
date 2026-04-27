## 17. What did you do when the subscribe callback was retried? Show the exact idempotency key you chose and why.

**What I did**

- I treated the subscribe callback as **idempotent** and safe to retry.
- Tenant creation is implemented as an **upsert**:
  - If tenant doesn’t exist → create `tenants` row (`status=ACTIVE`).
  - If tenant exists and is soft-deleted → “reactivate” (`deleted_at=NULL`, `status=ACTIVE`).
  - If tenant already active → only update `updated_at`.
- Audit writes are protected by a **unique idempotency key** to prevent duplicate rows.

**Exact idempotency key**

The subscribe handler uses:

`subscribe:${tenantId}:${subscribedSubaccountId}:${requestedBy}`

Implemented in `server.js` as:

- `tenantId`: from the callback path
- `subscribedSubaccountId`: from `body.subscribedSubaccountId` (or fallback `body.subaccountId`)
- `requestedBy`: from the “caller-specified user” field (admin user)

**Why**

- SaaS Provisioning retries can replay the exact same event; the key must be **stable across retries**.
- Using `tenantId` ensures we never create multiple tenant records for the same subscriber tenant.
- Including `subscribedSubaccountId` avoids collisions if a tenantId format ever differs or is reused across landscapes.
- Including `requestedBy` ensures we don't accidentally “dedupe” two distinct subscriptions where the provisioning caller differs (useful for audit traceability).

## 18. How did role-collection assignment work - SCIM, XSUAA REST API, or something else? What's the gotcha with assigning roles during the subscribe callback?

**How it works in this repo**

- I implemented role assignment via **IAS SCIM**:
  - Find user by `userName`
  - Find group by `displayName` (defaults to `S4_Admin`)
  - SCIM PATCH add user to group

This is coded in `src/roles.js` and enabled only when these env vars exist:
`IAS_SCIM_URL`, `IAS_SCIM_TOKEN_URL`, `IAS_SCIM_CLIENT_ID`, `IAS_SCIM_CLIENT_SECRET`.

**The gotcha**

- During the subscribe callback, the **subscriber user may not exist yet** (no first login / no user shadow in IAS / trust not established), so assignment can fail even though provisioning is correct.
- Role collections are a **subaccount concept**; if you're trying to assign collections in the subscriber subaccount from the provider-side callback, you need:
  - The right admin permissions + API endpoints for the subscriber account, and
  - A reliable identity to target (user must be known to the IdP / IAS).
- Practical pattern: make role assignment **best-effort + retryable**, and log failures for follow-up.

## 19. If you had to support 1000 tenants instead of 10, what's the first thing that breaks in your design?

**First breaking point: single shared DB + synchronous request path**

- This minimal implementation uses a single SQLite file DB and performs writes directly in the HTTP request.
- At 1000 tenants (and many concurrent subscriptions/unsubscriptions), you'd hit:
  - Write contention / I/O limits (SQLite/WAL on CF disk is not an enterprise choice)
  - Limited operational visibility / scaling constraints

**First fix**

- Move persistence to **SAP HANA Cloud** (or another managed DB) and
- Decouple provisioning side effects (role assignment, downstream calls) using a **queue / async job** so subscribe callbacks remain fast and reliable.

## 20. What's the exact difference between a role-template, a role, and a role-collection in XSUAA - and why does it matter here?

- **Role-template**: a *definition shipped by the app* in `xs-security.json` that bundles scopes (and optional attributes). It’s not assigned directly to users.
- **Role (role instance)**: a concrete role created from a role-template in a specific subaccount; it represents an assignable unit **inside the subaccount**, but still typically not assigned to users directly.
- **Role-collection**: a container of roles intended for assignment to **users**. This is what administrators actually assign.

**Why it matters here**

- `/tenants` must be restricted to platform admins. The repo implements this by:
  - Shipping a scope `$XSAPPNAME.PlatformAdmin`
  - Shipping a role-template `PlatformAdmin` that references that scope
  - Shipping a role-collection `S4_Platform_Admin` that references the `PlatformAdmin` template
- This makes it easy for subaccount admins to assign **one role collection** (`S4_Platform_Admin`) to the correct operators, and ensures regular tenant users get **403**.

