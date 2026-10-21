import { HttpError } from '../common/errors';
import { canonicalJson, randomHex, sha256Hex, verifyMessage } from '../common/crypto';
import { FEE_ACCOUNT, GAS_FEE, OVERRIDE_CEILING, SPONSOR_ACCOUNT, X402_DAILY_CAP } from '../common/config';
import { hardened } from '../common/harden';
import { parseMicros } from '../common/money';
import { evaluatePolicy, type Mandate } from './policy';
import { tx, type Db } from './db';

type Row = Record<string, unknown>;

export interface LedgerOptions {
  now?: () => Date;
}

const toPayment = (r: Row, payeeName: string) => ({
  id: r.id as string,
  invoiceId: r.invoice_id as string,
  payeeId: r.payee_id as string,
  payeeName,
  amount: String(r.amount),
  status: r.status as 'pending_approval' | 'settled' | 'rejected' | 'denied' | 'failed',
  requestedBy: r.requested_by as string,
  approvedBy: (r.approved_by as string | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

/** Core ledger logic, independent of HTTP so it is directly unit-testable. */
export class LedgerService {
  private now: () => Date;

  constructor(
    private db: Db,
    opts: LedgerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  private ts = () => this.now().toISOString();

  private one(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private run(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).run(...params);
  }

  audit(actor: string, action: string, detail: unknown): void {
    this.run('INSERT INTO audit(ts, actor, action, detail) VALUES (?,?,?,?)', this.ts(), actor, action, JSON.stringify(detail));
  }

  // ---- reads -------------------------------------------------------------------------------------------------

  /** Every account, for the read-only dashboard. */
  listAccounts() {
    return this.all('SELECT id, name, balance FROM accounts ORDER BY id').map((r) => ({ id: r.id as string, name: r.name as string, balance: String(r.balance) }));
  }

  getAccount(id: string) {
    const r = this.one('SELECT id, name, balance FROM accounts WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'account_not_found');
    return { id: r.id as string, name: r.name as string, balance: String(r.balance) };
  }

  listPayees() {
    return this.all('SELECT id, name, account_id, verified FROM payees ORDER BY id').map((r) => ({
      id: r.id as string,
      name: r.name as string,
      accountId: r.account_id as string,
      verified: r.verified === 1,
    }));
  }

  private invoiceDto(r: Row) {
    const payee = this.one('SELECT name FROM payees WHERE id = ?', r.payee_id as string);
    return {
      id: r.id as string,
      payeeId: r.payee_id as string,
      payeeName: (payee?.name as string) ?? 'unknown',
      amount: String(r.amount),
      memo: r.memo as string,
      status: r.status as 'open' | 'paid',
      dueDate: r.due_date as string,
    };
  }

  listInvoices(status?: string) {
    const rows = status ? this.all('SELECT * FROM invoices WHERE status = ? ORDER BY id', status) : this.all('SELECT * FROM invoices ORDER BY id');
    return rows.map((r) => this.invoiceDto(r));
  }

  /** Intake: file a new open invoice for a known vendor (looked up by legal name). */
  createInvoice(i: { id: string; vendor: string; amount: string; memo: string; dueDate: string }) {
    const payee = this.one('SELECT id FROM payees WHERE lower(name) = lower(?)', i.vendor);
    if (!payee) throw new HttpError(404, 'unknown_vendor', `no vendor named ${i.vendor}`);
    if (this.one('SELECT id FROM invoices WHERE id = ?', i.id)) throw new HttpError(409, 'invoice_exists', `${i.id} already exists`);
    this.db.prepare('INSERT INTO invoices(id, payee_id, amount, memo, status, due_date) VALUES (?,?,?,?,?,?)').run(
      i.id, payee.id as string, parseMicros(i.amount), i.memo, 'open', i.dueDate || '2026-12-31');
    return this.getInvoice(i.id);
  }

  getInvoice(id: string) {
    const r = this.one('SELECT * FROM invoices WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'invoice_not_found');
    return this.invoiceDto(r);
  }

  getAgent(id: string) {
    const r = this.one('SELECT id, public_key, wallet_account, operating_account, scopes FROM agents WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'agent_not_found');
    return { id: r.id as string, publicKey: r.public_key as string, walletAccount: r.wallet_account as string, operatingAccount: r.operating_account as string, scopes: JSON.parse(r.scopes as string) as string[] };
  }

  agentByToken(token: string) {
    const r = this.one('SELECT id FROM agents WHERE token_hash = ?', sha256Hex(token));
    if (!r) throw new HttpError(401, 'invalid_agent_token');
    return this.getAgent(r.id as string);
  }

  private signer(id: string) {
    const r = this.one('SELECT id, name, public_key FROM approvers WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'unknown_signer');
    return { id: r.id as string, name: r.name as string, publicKey: r.public_key as string };
  }

  /**
   * The transaction a signer signs for a payment: what the ledger will execute (from, to, asset, amount, invoice, payment id).
   * `message` is the exact byte string that is signed; `digest` is its hash, the "transaction hash" a signing screen can show.
   */
  paymentTransaction(id: string) {
    const p = this.one('SELECT * FROM payments WHERE id = ?', id);
    if (!p) throw new HttpError(404, 'payment_not_found');
    const agent = this.getAgent(p.requested_by as string);
    const payee = this.one('SELECT account_id FROM payees WHERE id = ?', p.payee_id as string)!;
    const txn = {
      chain: 'dvap:local', type: 'transfer', asset: 'USDC',
      from: agent.operatingAccount, to: payee.account_id as string, amount: String(p.amount), invoice: p.invoice_id as string, payment: id,
    };
    const message = canonicalJson(txn);
    return { tx: txn, message, digest: '0x' + sha256Hex(message) };
  }

  /** A signer's signature over `message`, checked against the public key the ledger holds for that signer. */
  private checkSignature(signerId: string, message: string, signature: string) {
    const signer = this.signer(signerId);
    if (!verifyMessage(signer.publicKey, message, signature)) throw new HttpError(403, 'bad_signature');
    return signer;
  }

  private payeeName(id: string): string {
    return (this.one('SELECT name FROM payees WHERE id = ?', id)?.name as string) ?? 'unknown';
  }

  getPayment(id: string) {
    const r = this.one('SELECT * FROM payments WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'payment_not_found');
    return toPayment(r, this.payeeName(r.payee_id as string));
  }

  listPayments(status?: string) {
    const rows = status ? this.all('SELECT * FROM payments WHERE status = ? ORDER BY created_at', status) : this.all('SELECT * FROM payments ORDER BY created_at');
    return rows.map((r) => toPayment(r, this.payeeName(r.payee_id as string)));
  }

  listAudit(limit: number) {
    return this.all('SELECT id, ts, actor, action, detail FROM audit ORDER BY id DESC LIMIT ?', limit).map((r) => ({
      id: r.id as number,
      ts: r.ts as string,
      actor: r.actor as string,
      action: r.action as string,
      detail: r.detail as string,
    }));
  }

  nonceUsed(nonce: string): boolean {
    return this.one('SELECT 1 AS x FROM used_nonces WHERE nonce = ?', nonce) !== undefined;
  }

  private mandate(agentId: string): Mandate {
    const m = this.one('SELECT * FROM mandates WHERE agent_id = ?', agentId);
    if (!m) throw new HttpError(403, 'no_mandate', 'agent has no payment mandate');
    return {
      perTxCap: m.per_tx_cap as number,
      dailyCap: m.daily_cap as number,
      approvalThreshold: m.approval_threshold as number,
      allowedPayees: JSON.parse(m.allowed_payees as string) as string[],
    };
  }

  private spentToday(agentId: string): number {
    const dayStart = this.ts().slice(0, 10); // UTC date prefix of ISO timestamp
    const r = this.one(
      `SELECT COALESCE(SUM(amount),0) AS s FROM payments
       WHERE requested_by = ? AND status IN ('pending_approval','settled') AND created_at >= ?`,
      agentId,
      dayStart,
    );
    return (r?.s as number) ?? 0;
  }

  // ---- payments ----------------------------------------------------------------------------------------------

  /**
   * V12: several payments in one call. VULNERABLE BY DEFAULT: the daily cap is checked against ONE snapshot of "spent today" taken
   * before any of them is recorded, so a batch can overshoot the cap by the sum of its parts (a check-then-act race in one call).
   * DVAP_HARDEN=V12: each item sees the previous items' spend.
   */
  createPaymentsBatch(agentId: string, items: { invoiceId: string; payeeId: string; amount: string; note?: string }[]) {
    const snapshot = this.spentToday(agentId);
    return items.map((it) => this.createPayment({ agentId, ...it }, hardened('V12') ? undefined : snapshot));
  }

  createPayment(input: { agentId: string; invoiceId: string; payeeId: string; amount: string; note?: string; override?: string }, spentSnapshot?: number) {
    let amount: number;
    try {
      amount = parseMicros(input.amount);
    } catch (e) {
      throw new HttpError(400, 'invalid_amount', (e as Error).message);
    }
    return tx(this.db, () => {
      const agent = this.getAgent(input.agentId);
      const mandate = this.mandate(agent.id);
      const invoice = this.one('SELECT * FROM invoices WHERE id = ?', input.invoiceId);
      if (!invoice) throw new HttpError(404, 'invoice_not_found');
      if (invoice.status !== 'open') throw new HttpError(409, 'invoice_not_open');
      // A payment is bound to exactly one invoice: same payee, same amount. The agent cannot redirect or resize it.
      if (invoice.payee_id !== input.payeeId) throw new HttpError(422, 'payee_mismatch', 'payee does not match the invoice');
      if (invoice.amount !== amount) throw new HttpError(422, 'amount_mismatch', 'amount does not match the invoice');
      const payee = this.one('SELECT * FROM payees WHERE id = ?', input.payeeId);
      if (!payee) throw new HttpError(404, 'payee_not_found');
      if (this.one(`SELECT 1 AS x FROM payments WHERE invoice_id = ? AND status IN ('pending_approval','settled')`, input.invoiceId)) {
        throw new HttpError(409, 'duplicate_payment', 'invoice already has an active payment');
      }

      const decision = evaluatePolicy({
        amount,
        payeeId: input.payeeId,
        payeeVerified: payee.verified === 1,
        spentToday: spentSnapshot ?? this.spentToday(agent.id),
        mandate,
      });
      const id = 'pay_' + randomHex(6);
      const ts = this.ts();
      const insert = (status: string, reason: string | null) =>
        this.run(
          'INSERT INTO payments(id, invoice_id, payee_id, amount, status, requested_by, reason, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          id, input.invoiceId, input.payeeId, amount, status, agent.id, reason, input.note ?? null, ts, ts,
        );

      if (decision.decision === 'deny') {
        insert('denied', decision.reason);
        this.audit(agent.id, 'payment.denied', { id, invoiceId: input.invoiceId, amount, reason: decision.reason });
        return this.getPayment(id);
      }
      // V26: "emergency override" — an agent may skip human approval by giving a reason. It is meant to be capped at
      // OVERRIDE_CEILING. VULNERABLE BY DEFAULT: the ceiling is not enforced, so the only limit left is the per-transaction cap.
      if (decision.decision === 'approval_required' && input.override && (!hardened('V26') || amount <= OVERRIDE_CEILING)) {
        insert('pending_approval', `override: ${input.override.slice(0, 100)}`);
        this.audit(agent.id, 'payment.override', { id, invoiceId: input.invoiceId, amount, reason: input.override });
        this.settle(id, `override:${agent.id}`);
        return this.getPayment(id);
      }
      if (decision.decision === 'approval_required') {
        insert('pending_approval', decision.reason);
        this.audit(agent.id, 'payment.pending_approval', { id, invoiceId: input.invoiceId, amount });
        return this.getPayment(id);
      }
      insert('pending_approval', 'auto');
      this.settle(id, 'policy:auto');
      return this.getPayment(id);
    });
  }

  /** Change an agent's mandate / trusted-vendor list. Authorisation is the CALLER's job (see payments-mcp, V5). */
  updatePolicy(agentId: string, actor: string, patch: { perTxCap?: string; dailyCap?: string; allowPayees?: string[]; trustPayees?: string[] }) {
    return tx(this.db, () => {
      const m = this.mandate(agentId);
      const perTx = patch.perTxCap !== undefined ? parseMicros(patch.perTxCap) : m.perTxCap;
      const daily = patch.dailyCap !== undefined ? parseMicros(patch.dailyCap) : m.dailyCap;
      const allowed = [...new Set([...m.allowedPayees, ...(patch.allowPayees ?? [])])];
      for (const p of patch.trustPayees ?? []) {
        if (!this.one('SELECT 1 AS x FROM payees WHERE id = ?', p)) throw new HttpError(404, 'payee_not_found');
        this.run('UPDATE payees SET verified = 1 WHERE id = ?', p);
      }
      this.run('UPDATE mandates SET per_tx_cap=?, daily_cap=?, allowed_payees=? WHERE agent_id=?', perTx, daily, JSON.stringify(allowed), agentId);
      this.audit(actor, 'policy.updated', { agentId, patch });
      return { agentId, perTxCap: String(perTx), dailyCap: String(daily), allowedPayees: allowed };
    });
  }

  /** Move money and close the invoice. Caller owns the transaction. */
  private settle(paymentId: string, actor: string): void {
    const p = this.one('SELECT * FROM payments WHERE id = ?', paymentId)!;
    const agent = this.getAgent(p.requested_by as string);
    const payee = this.one('SELECT account_id FROM payees WHERE id = ?', p.payee_id as string)!;
    const amount = p.amount as number;
    const bal = this.one('SELECT balance FROM accounts WHERE id = ?', agent.operatingAccount)!;
    if ((bal.balance as number) < amount) {
      this.run(`UPDATE payments SET status='failed', reason='insufficient_funds', updated_at=? WHERE id=?`, this.ts(), paymentId);
      this.audit(actor, 'payment.failed', { id: paymentId, reason: 'insufficient_funds' });
      return;
    }
    this.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', amount, agent.operatingAccount);
    this.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', amount, payee.account_id as string);
    const txId = 'tx_' + randomHex(8);
    this.run('INSERT INTO transfers(id, from_account, to_account, amount, kind, ref, memo, created_at) VALUES (?,?,?,?,?,?,?,?)',
      txId, agent.operatingAccount, payee.account_id as string, amount, 'invoice', paymentId, `invoice ${p.invoice_id as string}`, this.ts());
    this.run(`UPDATE invoices SET status='paid' WHERE id = ?`, p.invoice_id as string);
    this.run(`UPDATE payments SET status='settled', updated_at=? WHERE id=?`, this.ts(), paymentId);
    this.audit(actor, 'payment.settled', { id: paymentId, invoiceId: p.invoice_id, amount, transfer: txId });
  }

  /** The CFO's signature over the payment's transaction releases it: the ledger executes the transfer once a valid signature is present. */
  signPayment(id: string, signerId: string, signature: string) {
    return tx(this.db, () => {
      const p = this.one('SELECT * FROM payments WHERE id = ?', id);
      if (!p) throw new HttpError(404, 'payment_not_found');
      if (p.status !== 'pending_approval') throw new HttpError(409, 'not_pending_approval');
      const { message, digest } = this.paymentTransaction(id);
      const approver = this.checkSignature(signerId, message, signature);
      if (p.requested_by === approver.id) throw new HttpError(403, 'self_approval_forbidden');
      const inv = this.one('SELECT status FROM invoices WHERE id = ?', p.invoice_id as string)!;
      if (inv.status !== 'open') throw new HttpError(409, 'invoice_not_open');
      this.run(`UPDATE payments SET approved_by=?, updated_at=? WHERE id=?`, approver.id, this.ts(), id);
      this.audit(approver.id, 'payment.approved', { id, digest, signed: true });
      this.settle(id, approver.id);
      return this.getPayment(id);
    });
  }

  /** A rejection is also signed: the signer signs `{"action":"reject","payment":<id>}`. */
  rejectPayment(id: string, signerId: string, signature: string, reason?: string) {
    return tx(this.db, () => {
      const p = this.one('SELECT * FROM payments WHERE id = ?', id);
      if (!p) throw new HttpError(404, 'payment_not_found');
      if (p.status !== 'pending_approval') throw new HttpError(409, 'not_pending_approval');
      const approver = this.checkSignature(signerId, canonicalJson({ action: 'reject', payment: id }), signature);
      this.run(`UPDATE payments SET status='rejected', approved_by=?, reason=?, updated_at=? WHERE id=?`, approver.id, reason ?? 'rejected_by_approver', this.ts(), id);
      this.audit(approver.id, 'payment.rejected', { id, reason });
      return this.getPayment(id);
    });
  }

  // ---- x402 transfers (called by the facilitator) --------------------------------------------------------------

  getTransfer(id: string) {
    const r = this.one('SELECT * FROM transfers WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'transfer_not_found');
    return { id: r.id as string, from: r.from_account as string, to: r.to_account as string, amount: String(r.amount), kind: r.kind as string, ref: r.ref as string, memo: r.memo as string };
  }

  /** The facilitator's gas sponsor fronts the network fee for a settlement attempt (V25). */
  sponsorFee() {
    return tx(this.db, () => {
      const s = this.one('SELECT balance FROM accounts WHERE id = ?', SPONSOR_ACCOUNT)!;
      if ((s.balance as number) < GAS_FEE) throw new HttpError(503, 'sponsor_depleted');
      this.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', GAS_FEE, SPONSOR_ACCOUNT);
      this.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', GAS_FEE, FEE_ACCOUNT);
      this.audit('facilitator', 'sponsor.fee', { fee: GAS_FEE });
      return { charged: String(GAS_FEE) };
    });
  }

  transfer(input: { from: string; to: string; amount: string; nonce: string; memo: string; payFee?: boolean }) {
    let amount: number;
    try {
      amount = parseMicros(input.amount);
    } catch (e) {
      throw new HttpError(400, 'invalid_amount', (e as Error).message);
    }
    return tx(this.db, () => {
      if (this.nonceUsed(input.nonce)) throw new HttpError(409, 'nonce_used');
      const from = this.one('SELECT balance FROM accounts WHERE id = ?', input.from);
      const to = this.one('SELECT id FROM accounts WHERE id = ?', input.to);
      if (!from || !to) throw new HttpError(404, 'account_not_found');
      const fee = input.payFee ? GAS_FEE : 0; // V25 hardened: the payer, not the sponsor, pays the network fee, atomically
      if ((from.balance as number) < amount + fee) throw new HttpError(402, 'insufficient_funds');
      // V6: the agent's x402 budget ("at most $5/day on paid APIs") is written in its system prompt. VULNERABLE BY DEFAULT:
      // nothing enforces it, so a loop, an injection or a rogue merchant can spend the whole wallet.
      // DVAP_HARDEN=V6: the ledger enforces the same budget, whatever the model was told or talked into.
      if (hardened('V6')) {
        const spent = this.one(
          `SELECT COALESCE(SUM(amount),0) AS s FROM transfers WHERE kind='x402' AND from_account=? AND created_at >= ?`,
          input.from, this.ts().slice(0, 10),
        );
        if (((spent?.s as number) ?? 0) + amount > X402_DAILY_CAP) throw new HttpError(402, 'x402_daily_cap');
      }
      this.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', amount + fee, input.from);
      this.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', amount, input.to);
      if (fee) this.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', fee, FEE_ACCOUNT);
      const txId = 'tx_' + randomHex(8);
      this.run('INSERT INTO transfers(id, from_account, to_account, amount, kind, ref, memo, created_at) VALUES (?,?,?,?,?,?,?,?)',
        txId, input.from, input.to, amount, 'x402', input.nonce, input.memo, this.ts());
      this.run('INSERT INTO used_nonces(nonce, transfer_id) VALUES (?,?)', input.nonce, txId);
      this.audit('facilitator', 'x402.transfer', { id: txId, from: input.from, to: input.to, amount, nonce: input.nonce });
      return { transaction: txId };
    });
  }
}
