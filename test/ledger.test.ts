import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dollars } from '../src/common/money';
import { AGENT_WALLET_ACCOUNT, OPERATING_ACCOUNT } from '../src/common/config';
import { bal, withStack, type TestStack } from './helpers';

let t: TestStack;
beforeAll(async () => { t = await withStack(); });
afterAll(async () => { await t.teardown(); });

const pay = (invoiceId: string, payeeId: string, amount: number | string) =>
  t.client.createPayment({ agentId: 'agent-1', invoiceId, payeeId, amount: String(amount) });

describe('ledger API auth', () => {
  it('rejects calls without the service key', async () => {
    expect((await fetch(`${t.urls.ledger}/payments`)).status).toBe(401);
    expect((await fetch(`${t.urls.ledger}/payments`, { headers: { 'x-service-key': 'wrong' } })).status).toBe(401);
    expect((await fetch(`${t.urls.ledger}/health`)).status).toBe(200);
  });
});

describe('payment policy in the ledger', () => {
  it('denies a payment to a payee outside the mandate (Globex) and moves no money', async () => {
    const before = await bal(t, OPERATING_ACCOUNT);
    const p = await pay('INV-2001', 'p_globex', dollars(9500));
    expect(p.status).toBe('denied');
    expect(p.reason).toBe('payee_not_in_mandate_allowlist');
    expect(await bal(t, OPERATING_ACCOUNT)).toBe(before);
  });

  it('rejects payee/amount that do not match the invoice (binding)', async () => {
    await expect(pay('INV-1001', 'p_hooli', dollars(1200))).rejects.toMatchObject({ code: 'payee_mismatch' });
    await expect(pay('INV-1001', 'p_initech', dollars(1))).rejects.toMatchObject({ code: 'amount_mismatch' });
    await expect(pay('INV-1001', 'p_initech', '1.5')).rejects.toMatchObject({ code: 'invalid_amount' });
    await expect(pay('INV-NOPE', 'p_initech', '5')).rejects.toMatchObject({ code: 'invoice_not_found' });
  });

  it('auto-settles a small payment (Hooli $300) and closes the invoice', async () => {
    const p = await pay('INV-1002', 'p_hooli', dollars(300));
    expect(p.status).toBe('settled');
    expect((await t.client.getInvoice('INV-1002')).status).toBe('paid');
    expect(await bal(t, 'acct_hooli')).toBe(dollars(300));
    await expect(pay('INV-1002', 'p_hooli', dollars(300))).rejects.toMatchObject({ code: 'invoice_not_open' });
  });

  it('holds a large payment for approval; agent cannot approve; CFO can; double-approve fails', async () => {
    const p = await pay('INV-1001', 'p_initech', dollars(1200));
    expect(p.status).toBe('pending_approval');
    await expect(pay('INV-1001', 'p_initech', dollars(1200))).rejects.toMatchObject({ code: 'duplicate_payment' });
    // the agent's bearer token is not an approver credential
    await expect(t.client.approvePayment(p.id, t.keys.agentToken)).rejects.toMatchObject({ code: 'invalid_approver_token' });
    expect(await bal(t, 'acct_initech')).toBe(0);
    const approved = await t.client.approvePayment(p.id, t.keys.cfoToken);
    expect(approved.status).toBe('settled');
    expect(approved.approvedBy).toBe('cfo');
    expect(await bal(t, 'acct_initech')).toBe(dollars(1200));
    await expect(t.client.approvePayment(p.id, t.keys.cfoToken)).rejects.toMatchObject({ code: 'not_pending_approval' });
  });

  it('audit log records every state change', async () => {
    const actions = (await t.client.audit(50)).entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['payment.denied', 'payment.settled', 'payment.pending_approval', 'payment.approved']));
  });
});

describe('x402 transfers', () => {
  it('rejects a reused nonce and an overdraft atomically', async () => {
    const w0 = await bal(t, AGENT_WALLET_ACCOUNT);
    const nonce = 'n'.repeat(16);
    await t.client.transfer({ from: AGENT_WALLET_ACCOUNT, to: 'acct_vettingco', amount: '1000', nonce, memo: 't' });
    await expect(t.client.transfer({ from: AGENT_WALLET_ACCOUNT, to: 'acct_vettingco', amount: '1000', nonce, memo: 't' })).rejects.toMatchObject({ code: 'nonce_used' });
    expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBe(w0 - 1000);
    await expect(t.client.transfer({ from: AGENT_WALLET_ACCOUNT, to: 'acct_vettingco', amount: String(dollars(999)), nonce: 'm'.repeat(16), memo: 't' }))
      .rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBe(w0 - 1000);
  });
});
