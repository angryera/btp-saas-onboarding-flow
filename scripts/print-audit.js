const { db, ensureSchema } = require('../src/db');

ensureSchema();

const rows = db
  .prepare(
    `SELECT id, idempotency_key, tenant_id, action, actor, created_at
     FROM audit_log
     ORDER BY id ASC`
  )
  .all();

console.table(rows);

