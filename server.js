const express = require('express');
const helmet = require('helmet');
const passport = require('passport');

const { initAuth, requireJwt, requireScope } = require('./src/auth');
const { ensureSchema, db } = require('./src/db');
const { assignDefaultAdminRoleCollection, revokeDefaultAdminRoleCollection } = require('./src/roles');

const app = express();
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

ensureSchema();
initAuth(app, passport);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// SaaS registry dependency callback (return reuse service dependencies if any).
// For this minimal handler, we don't declare reuse-service dependencies.
app.get('/callback/v1.0/dependencies', (_req, res) => {
  res.status(200).json([]);
});

function nowIso() {
  return new Date().toISOString();
}

function idempotencyKeyForSubscribe(tenantId, body) {
  // Key must be stable across retries for the same subscription event.
  // Use tenantId + subscriber subaccount (if provided) + subscribing user (if provided) to avoid duplication.
  const subaccountId = body?.subscribedSubaccountId || body?.subaccountId || 'unknown-subaccount';
  const requestedBy = body?.requestedBy || body?.user || body?.adminUser || 'unknown-requestedBy';
  return `subscribe:${tenantId}:${subaccountId}:${requestedBy}`;
}

function idempotencyKeyForUnsubscribe(tenantId, body) {
  const subaccountId = body?.subscribedSubaccountId || body?.subaccountId || 'unknown-subaccount';
  return `unsubscribe:${tenantId}:${subaccountId}`;
}

function writeAudit({ tenant_id, action, actor, idempotency_key, details }) {
  db.prepare(
    `INSERT OR IGNORE INTO audit_log (idempotency_key, tenant_id, action, actor, details_json, created_at)
     VALUES (@idempotency_key, @tenant_id, @action, @actor, @details_json, @created_at)`
  ).run({
    idempotency_key,
    tenant_id,
    action,
    actor: actor || null,
    details_json: details ? JSON.stringify(details) : null,
    created_at: nowIso()
  });
}

// SaaS Provisioning callbacks (recommended path pattern for SAP SaaS Provisioning Service)
// Subscribe: PUT /callback/v1.0/tenants/{tenantId}
// Unsubscribe: DELETE /callback/v1.0/tenants/{tenantId}

app.put('/callback/v1.0/tenants/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;
  const body = req.body || {};

  const requestedByUser = body?.subscriptionPayload?.adminUser || body?.adminUser || body?.requestedBy || body?.user;
  const tenantSubdomain = body?.subscribedSubdomain || body?.subdomain || body?.subscriptionPayload?.subdomain;
  const idempotencyKey = idempotencyKeyForSubscribe(tenantId, { ...body, requestedBy: requestedByUser });

  const existing = db
    .prepare('SELECT * FROM tenants WHERE tenant_id = ?')
    .get(tenantId);

  const createdAt = nowIso();
  if (!existing) {
    db.prepare(
      `INSERT INTO tenants (tenant_id, subdomain, status, created_at, updated_at, deleted_at)
       VALUES (?, ?, 'ACTIVE', ?, ?, NULL)`
    ).run(tenantId, tenantSubdomain || null, createdAt, createdAt);
  } else if (existing.deleted_at) {
    db.prepare(
      `UPDATE tenants
       SET status='ACTIVE', deleted_at=NULL, updated_at=?
       WHERE tenant_id=?`
    ).run(createdAt, tenantId);
  } else {
    db.prepare('UPDATE tenants SET updated_at=? WHERE tenant_id=?').run(createdAt, tenantId);
  }

  writeAudit({
    tenant_id: tenantId,
    action: 'SUBSCRIBE',
    actor: requestedByUser,
    idempotency_key: idempotencyKey,
    details: { tenantSubdomain, requestedByUser, raw: body }
  });

  // Best-effort role assignment (idempotent per tenant+user).
  // This is usually tricky in real SaaS: the user might not exist yet / trust not established / needs IAS group mapping.
  if (requestedByUser) {
    try {
      await assignDefaultAdminRoleCollection({
        tenantId,
        userEmailOrLogin: requestedByUser
      });
    } catch (e) {
      writeAudit({
        tenant_id: tenantId,
        action: 'ROLE_ASSIGN_FAILED',
        actor: requestedByUser,
        idempotency_key: `${idempotencyKey}:role-assign-failed`,
        details: { message: e?.message || String(e) }
      });
    }
  }

  // SaaS Provisioning expects a URL to the tenant-specific app route (or provider route) depending on design.
  // For this assessment: return a minimal response.
  res.status(200).json({
    subscriptionUrl: process.env.SUBSCRIPTION_URL || 'https://example.invalid/tenant',
    message: 'Subscribed (idempotent)'
  });
});

app.delete('/callback/v1.0/tenants/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;
  const body = req.body || {};

  const requestedByUser = body?.subscriptionPayload?.adminUser || body?.adminUser || body?.requestedBy || body?.user;
  const idempotencyKey = idempotencyKeyForUnsubscribe(tenantId, body);

  const existing = db
    .prepare('SELECT * FROM tenants WHERE tenant_id = ?')
    .get(tenantId);

  const updatedAt = nowIso();
  if (!existing) {
    // Soft-delete semantics even if we never saw subscribe (retry/out-of-order): create record as DELETED.
    db.prepare(
      `INSERT INTO tenants (tenant_id, subdomain, status, created_at, updated_at, deleted_at)
       VALUES (?, NULL, 'DELETED', ?, ?, ?)`
    ).run(tenantId, updatedAt, updatedAt, updatedAt);
  } else if (!existing.deleted_at) {
    db.prepare(
      `UPDATE tenants
       SET status='DELETED', deleted_at=?, updated_at=?
       WHERE tenant_id=?`
    ).run(updatedAt, updatedAt, tenantId);
  } else {
    db.prepare('UPDATE tenants SET updated_at=? WHERE tenant_id=?').run(updatedAt, tenantId);
  }

  writeAudit({
    tenant_id: tenantId,
    action: 'UNSUBSCRIBE',
    actor: requestedByUser,
    idempotency_key: idempotencyKey,
    details: { raw: body }
  });

  // Best-effort revoke role assignment.
  if (requestedByUser) {
    try {
      await revokeDefaultAdminRoleCollection({
        tenantId,
        userEmailOrLogin: requestedByUser
      });
    } catch (e) {
      writeAudit({
        tenant_id: tenantId,
        action: 'ROLE_REVOKE_FAILED',
        actor: requestedByUser,
        idempotency_key: `${idempotencyKey}:role-revoke-failed`,
        details: { message: e?.message || String(e) }
      });
    }
  }

  res.status(200).json({ message: 'Unsubscribed (soft-deleted)' });
});

// Platform admin endpoint
app.get('/tenants', requireJwt(passport), requireScope('PlatformAdmin'), (req, res) => {
  const rows = db.prepare(
    `SELECT tenant_id, subdomain, status, created_at, updated_at, deleted_at
     FROM tenants
     ORDER BY created_at ASC`
  ).all();

  res.json({
    count: rows.length,
    tenants: rows
  });
});

// Default error handler
app.use((err, _req, res, _next) => {
  const status = err?.status || 500;
  res.status(status).json({
    error: status === 500 ? 'internal_error' : 'request_error',
    message: err?.message || 'Unexpected error'
  });
});

const port = Number(process.env.PORT || 5005);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Listening on :${port}`);
});

