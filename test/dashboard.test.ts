import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withStack, type TestStack } from './helpers';

let t: TestStack;
beforeEach(async () => { delete process.env.DVAP_HARDEN; t = await withStack(); });
afterEach(async () => { await t.teardown(); });

const state = async () => (await fetch(`${t.urls.dashboard}/api/state`)).json() as Promise<{
  accounts: { id: string; balance: string }[];
  payments: { invoiceId: string; status: string }[];
  audit: { actor: string; action: string }[];
}>;

describe('ledger dashboard (read-only operator view)', () => {
  it('serves a page that builds its content with textContent, never innerHTML', async () => {
    const res = await fetch(t.urls.dashboard);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Ledger');
    expect(html).not.toMatch(/innerHTML/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('shows every account, with the seeded balances', async () => {
    const s = await state();
    const bal = Object.fromEntries(s.accounts.map((a) => [a.id, a.balance]));
    expect(bal.acct_acme_operating).toBe('50000000000');
    expect(bal.acct_globex).toBe('0');
    expect(bal.acct_globex_drop).toBe('0');
    expect(s.accounts.length).toBeGreaterThanOrEqual(10);
  });

  it('reflects a settled payment in balances, payments and the audit log', async () => {
    const p = await t.client.createPayment({ agentId: t.keys.agentId, invoiceId: 'INV-1002', payeeId: 'p_hooli', amount: '300000000' });
    expect(p.status).toBe('settled');
    const s = await state();
    expect(s.accounts.find((a) => a.id === 'acct_hooli')?.balance).toBe('300000000');
    expect(s.payments.find((x) => x.invoiceId === 'INV-1002')?.status).toBe('settled');
    expect(s.audit.some((e) => e.action === 'payment.settled')).toBe(true);
  });

  it('only reads: the dashboard has no write routes', async () => {
    expect((await fetch(`${t.urls.dashboard}/api/state`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${t.urls.dashboard}/api/payments/x/sign`, { method: 'POST' })).status).toBe(404);
  });
});
