import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

// node:sqlite is loaded through createRequire so bundlers/test runners treat it as a plain builtin.
const require = createRequire(import.meta.url);
const { DatabaseSync: Sqlite } = require('node:sqlite') as typeof import('node:sqlite');

export type Db = DatabaseSync;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, balance INTEGER NOT NULL CHECK(balance >= 0));
CREATE TABLE IF NOT EXISTS payees(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), verified INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invoices(
  id TEXT PRIMARY KEY, payee_id TEXT NOT NULL REFERENCES payees(id),
  amount INTEGER NOT NULL CHECK(amount > 0), memo TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','paid')), due_date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, public_key TEXT NOT NULL,
  wallet_account TEXT NOT NULL REFERENCES accounts(id),
  operating_account TEXT NOT NULL REFERENCES accounts(id), token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS mandates(
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  per_tx_cap INTEGER NOT NULL, daily_cap INTEGER NOT NULL,
  approval_threshold INTEGER NOT NULL, allowed_payees TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments(
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
  payee_id TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_approval','settled','rejected','denied','failed')),
  requested_by TEXT NOT NULL, approved_by TEXT, reason TEXT, note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_payment_per_invoice
  ON payments(invoice_id) WHERE status IN ('pending_approval','settled');
CREATE TABLE IF NOT EXISTS transfers(
  id TEXT PRIMARY KEY, from_account TEXT NOT NULL, to_account TEXT NOT NULL, amount INTEGER NOT NULL,
  kind TEXT NOT NULL, ref TEXT, memo TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS used_nonces(nonce TEXT PRIMARY KEY, transfer_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
`;

export function openDb(file: string): Db {
  const db = new Sqlite(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside an IMMEDIATE transaction (single writer; serialises the balance/limit checks). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
