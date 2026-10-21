import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dollars } from '../src/common/money';
import { AGENT_WALLET_ACCOUNT, MERCHANT_ACCOUNT, OPERATING_ACCOUNT } from '../src/common/config';
import { runAgent } from '../src/agent/runner';
import { bal, cfoClick, withStack, type TestStack } from './helpers';

let t: TestStack;
beforeAll(async () => { t = await withStack(); });
afterAll(async () => { await t.teardown(); });

async function waitForPending(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const { payments } = await t.client.listPayments('pending_approval');
    if (payments[0]) return payments[0].id;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no pending payment appeared');
}

describe('PayPilot end-to-end', () => {
  it('MCP endpoint requires a valid bearer token', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(t.urls.mcp, { method: 'POST', headers: h, body })).status).toBe(401);
    expect((await fetch(t.urls.mcp, { method: 'POST', headers: { ...h, authorization: 'Bearer nope' }, body })).status).toBe(401);
    expect((await fetch(t.urls.mcp, { method: 'POST', headers: { ...h, authorization: `Bearer ${t.keys.agentToken}` }, body })).status).toBe(200);
  });

  it('small invoice (Hooli $300): vets vendor via x402, pays automatically', async () => {
    const w = await bal(t, AGENT_WALLET_ACCOUNT);
    const r = await runAgent('Pay the Hooli invoice', t.agentConfig());
    expect(r.outcome).toBe('paid');
    expect(await bal(t, 'acct_hooli')).toBe(dollars(300));
    expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBe(w - 250000 - (process.env.DVAP_HARDEN === 'all' ? 10_000 : 0)); // VettingCo 0.25 (+ network fee when V25 is fixed)
  });

  it('large invoice (Initech $1,200): waits for CFO approval in the approval UI, then settles', async () => {
    const run = runAgent('Pay the Initech invoice', t.agentConfig());
    const id = await waitForPending();
    // The UI page and its API are served and render the ledger's own record of the payment.
    const page = await fetch(t.urls.approval);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('CFO approve and sign');
    const pending = (await (await fetch(`${t.urls.approval}/api/pending`)).json()) as { payments: { id: string; payeeName: string; amount: string }[] };
    expect(pending.payments[0]).toMatchObject({ id, payeeName: 'Initech Systems', amount: String(dollars(1200)) });
    expect(await bal(t, 'acct_initech')).toBe(0); // nothing moved before approval
    const ok = await cfoClick(t.urls.approval, id);
    expect(ok.status).toBe(200);
    const r = await run;
    expect(r.outcome).toBe('paid');
    expect(await bal(t, 'acct_initech')).toBe(dollars(1200));
    expect(await bal(t, OPERATING_ACCOUNT)).toBe(dollars(50_000) - dollars(300) - dollars(1200));
    expect(await bal(t, MERCHANT_ACCOUNT)).toBe(250000 * 2); // two vendor checks so far: Hooli, Initech
  });

  it('risky new vendor (Globex $9,500): agent vets, sees risk 83, refuses; no payment is even requested', async () => {
    const before = (await t.client.listPayments()).payments.length;
    const r = await runAgent('Pay invoice INV-2001', t.agentConfig());
    expect(r.outcome).toBe('aborted');
    expect(r.vendorRisk).toBe(83);
    expect((await t.client.listPayments()).payments.length).toBe(before);
    expect(await bal(t, 'acct_globex')).toBe(0);
  });

  it('CFO rejection ends the run without moving money', async () => {
    // reopen a fresh stack so there is a pending-able invoice again
    const t2 = await withStack();
    try {
      const run = runAgent('Pay the Initech invoice', t2.agentConfig());
      let id = '';
      for (let i = 0; i < 200 && !id; i++) {
        id = (await t2.client.listPayments('pending_approval')).payments[0]?.id ?? '';
        await new Promise((r) => setTimeout(r, 25));
      }
      expect((await cfoClick(t2.urls.approval, id, 'reject')).status).toBe(200);
      const r = await run;
      expect(r.outcome).toBe('rejected');
      expect(await bal(t2, 'acct_initech')).toBe(0);
    } finally {
      await t2.teardown();
    }
  });

  it('approval times out cleanly if nobody approves', async () => {
    const t3 = await withStack();
    try {
      const r = await runAgent('Pay the Initech invoice', t3.agentConfig({ approvalTimeoutMs: 300 }));
      expect(r.outcome).toBe('pending_approval');
      expect(await bal(t3, 'acct_initech')).toBe(0);
    } finally {
      await t3.teardown();
    }
  });
});
