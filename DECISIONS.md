## 17. What did you do when the subscribe callback was retried? Show the exact idempotency key you chose and why.

I assumed the SaaS Provisioning Service can (and will) retry callbacks, so the subscribe handler is **idempotent**.

- Tenant creation is effectively an **upsert**:
  - If the tenant doesn’t exist yet, I create a row in `tenants` with `status=ACTIVE`.
  - If the tenant exists but was previously unsubscribed, I “reactivate” it by setting `deleted_at=NULL` and `status=ACTIVE`.
  - If the tenant is already active, I only touch `updated_at`.
- Audit entries are deduped using a **unique idempotency key** (so a retry doesn’t spam audit rows).

**Exact idempotency key**

The subscribe handler uses:

`subscribe:${tenantId}:${subscribedSubaccountId}:${requestedBy}`

Where the parts come from in `server.js`:

- `tenantId`: from the callback path
- `subscribedSubaccountId`: from `body.subscribedSubaccountId` (or fallback `body.subaccountId`)
- `requestedBy`: from the “caller-specified user” field (admin user)

**Why**

- It’s **stable across retries** of the same subscription event.
- `tenantId` is the core unique tenant identifier (so we never create two tenant records for one subscriber).
- Adding `subscribedSubaccountId` reduces the chance of collisions if a tenantId format ever differs across landscapes.
- Adding `requestedBy` keeps the audit trail more specific (and avoids accidentally collapsing two distinct calls that happen to use the same `tenantId`).

## 18. How did role-collection assignment work - SCIM, XSUAA REST API, or something else? What's the gotcha with assigning roles during the subscribe callback?

**How it works in this repo**

- I implemented role assignment via **IAS SCIM** (group membership):
  - Find user by `userName`
  - Find group by `displayName` (defaults to `S4_Admin`)
  - SCIM PATCH add user to group

This is coded in `src/roles.js` and enabled only when these env vars exist:
`IAS_SCIM_URL`, `IAS_SCIM_TOKEN_URL`, `IAS_SCIM_CLIENT_ID`, `IAS_SCIM_CLIENT_SECRET`.

**The gotcha**

- During the subscribe callback, the **user you want to grant access to might not exist yet** (no first login, no user record in IAS yet, trust not fully set up). So role assignment can fail even when provisioning itself is correct.
- Role collections live at the **subaccount** level. If you try to assign them from the provider callback, you need:
  - The right admin permissions + API endpoints for the subscriber account, and
  - A reliable identity to target (user must be known to the IdP / IAS).
- The practical pattern is: treat role assignment as **best-effort**, make it retryable, and **log failures** so you can fix them later.

## 19. If you had to support 1000 tenants instead of 10, what's the first thing that breaks in your design?

**First breaking point: single shared DB + synchronous callback work**

- This minimal implementation uses a single SQLite file DB and performs writes directly in the HTTP request.
- At 1000 tenants (and many concurrent subscriptions/unsubscriptions), you'd hit:
  - Write contention / I/O limits (SQLite/WAL on CF disk is not an enterprise choice)
  - Limited operational visibility / scaling constraints

**First fix**

- Move persistence to **SAP HANA Cloud** (or another managed DB).
- Push side effects (role assignment, downstream calls) into a **queue / async job** so the subscribe callback stays fast and reliable.

## 20. What's the exact difference between a role-template, a role, and a role-collection in XSUAA - and why does it matter here?

- **Role-template**: a role definition shipped with the app in `xs-security.json` (it bundles scopes, and optionally attributes). You don’t assign role-templates directly to users.
- **Role (role instance)**: a concrete role created from a role-template inside a specific subaccount.
- **Role-collection**: what you actually assign to users. It groups one or more role instances into something admins can manage easily.

**Why it matters here**

- `/tenants` must be restricted to platform admins. The repo implements this by:
  - Shipping a scope `$XSAPPNAME.PlatformAdmin`
  - Shipping a role-template `PlatformAdmin` that references that scope
  - Shipping a role-collection `S4_Platform_Admin` that references the `PlatformAdmin` template
- This keeps the operational step simple: assign **one role collection** (`S4_Platform_Admin`) to platform operators, and everyone else correctly gets **403**.

