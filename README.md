# Task 5 — Multi-tenant onboarding flow (BTP SaaS)

This repo contains a minimal **SaaS Provisioning Service callback handler** that:

- Handles **subscribe** (`PUT /callback/v1.0/tenants/:tenantId`) and **unsubscribe** (`DELETE /callback/v1.0/tenants/:tenantId`)
- Persists **tenant records** with **soft-delete** (`deleted_at`) and audit history
- Exposes **`GET /tenants`** (platform admin only; scope `$XSAPPNAME.PlatformAdmin`, delivered via role-collection `S4_Platform_Admin`)

## Local run

```bash
npm install
npm run dev
```

Health check:

```bash
curl http://localhost:5005/health
```

## SaaS callback payload expectations

The handler looks for a caller-specified user in (first match wins):

- `body.subscriptionPayload.adminUser`
- `body.adminUser`
- `body.requestedBy`
- `body.user`

It stores the raw request body in the audit record (`details_json`) for proof.

## Role-collection assignment (optional, configurable)

The code includes a **best-effort** “assign default admin” step via **IAS SCIM**.
If you don't configure SCIM env vars, the app will still provision tenants and audit, but will skip role assignment.

Required env vars:

- `IAS_SCIM_URL` (e.g. `https://<tenant>.accounts.ondemand.com/scim/v2`)
- `IAS_SCIM_TOKEN_URL` (OAuth token endpoint)
- `IAS_SCIM_CLIENT_ID`
- `IAS_SCIM_CLIENT_SECRET`
- Optional: `DEFAULT_ADMIN_GROUP_NAME` (default: `S4_Admin`)

> In a real SaaS, mapping an IAS Group to a BTP Role Collection typically requires **IAS Group → Role Collection mapping** in the subaccount.

## Deploy (Cloud Foundry)

Build + deploy:

```bash
mbt build
cf deploy mta_archives/s4accelerate-saas-provisioning_1.0.0.mtar
```

Bind/register the app in **SaaS Provisioning Service** with callback base URL:

- `https://<app-route>/callback/v1.0/tenants/{tenantId}`

## Data retention

Unsubscribe uses soft-delete only. Tenant rows remain in DB; `deleted_at` records when it was deleted.
Retention of ≥ 90 days is supported by design (no hard delete).

