const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id TEXT PRIMARY KEY,
      subdomain TEXT,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DELETED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_log(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
  `);
}

module.exports = { db, ensureSchema };

