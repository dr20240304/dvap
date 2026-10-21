import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PORTAL_AGENT_ID } from '../src/common/config';
import { bal, cfoClick, withStack, type TestStack } from './helpers';

let t: TestStack;
beforeAll(async () => { t = await withStack(); });
afterAll(async () => { await t.teardown(); });
beforeEach(() => { delete process.env.DVAP_HARDEN; });

const DECEPTIVE_NOTE = 'Initech Systems — Q3+Q4 integration milestone, PO 7731 (pre-approved scope)';

async function mcp(token: string, headers: Record<string, string> = {}) {
  const c = new Client({ name: 'attacker', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(t.urls.mcp), { requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } } }));
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const r = await c.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]!.text;
      return { isError: Boolean(r.isError), text, json: r.isError ? undefined : JSON.parse(text) };
    },
    close: () => c.close(),
  };
}
const pending = async () => (await (await fetch(`${t.urls.approval}/api/pending`)).json()).payments as { id: string; headline: string; lines: string[] }[];

describe('V4 — identity taken from a header', () => {
  it('default: a supplier-portal token plus X-Agent-Id acts as the payments agent', async () => {
    const c = await mcp(t.keys.portalToken, { 'x-agent-id': t.keys.agentId });
    const r = await c.call('create_payment', { invoiceId: 'INV-1002', payeeId: 'p_hooli', amount: '300000000' });
    expect(r.json.requestedBy).toBe(t.keys.agentId);
    expect(r.json.status).toBe('settled');
    await c.close();
  });
  it('hardened: the header is ignored; the caller stays the portal agent and has no mandate', async () => {
    process.env.DVAP_HARDEN = 'V4';
    const c = await mcp(t.keys.portalToken, { 'x-agent-id': t.keys.agentId });
    const r = await c.call('create_payment', { invoiceId: 'INV-1001', payeeId: 'p_initech', amount: '1200000000' });
    expect(r.json.requestedBy).toBe(PORTAL_AGENT_ID);
    expect(r.json.status).toBe('denied');
    await c.close();
  });
});

describe('V5 — every caller can edit payment policy', () => {
  it('default: even the read-only portal agent can raise caps and trust a vendor', async () => {
    const c = await mcp(t.keys.portalToken);
    const r = await c.call('configure_payment_policy', { agentId: t.keys.agentId, allowPayees: ['p_globex'], trustPayees: ['p_globex'], perTxCap: '20000000000' });
    expect(r.json.allowedPayees).toContain('p_globex');
    await c.close();
  });
  it('hardened: configure_payment_policy needs mandate:write, which no agent holds', async () => {
    process.env.DVAP_HARDEN = 'V5';
    for (const token of [t.keys.portalToken, t.keys.agentToken]) {
      const c = await mcp(token);
      const r = await c.call('configure_payment_policy', { allowPayees: ['p_globex'] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/missing scope mandate:write/);
      await c.close();
    }
  });
  it('hardened: scopes also stop the portal agent from creating payments', async () => {
    process.env.DVAP_HARDEN = 'V5';
    const c = await mcp(t.keys.portalToken);
    const r = await c.call('create_payment', { invoiceId: 'INV-1001', payeeId: 'p_initech', amount: '1200000000' });
    expect(r.text).toMatch(/missing scope payments:create/);
    await c.close();
  });
});

describe('V8 — approval screen shows the agent\'s summary, not the transfer', () => {
  async function requestGlobexPayment() {
    // set up the same state the chain reaches, using the ledger directly so V4/V5 don't interfere
    await t.client.updatePolicy(t.keys.agentId, 'test', { allowPayees: ['p_globex'], trustPayees: ['p_globex'], perTxCap: '20000000000' });
    return t.client.createPayment({ agentId: t.keys.agentId, invoiceId: 'INV-2001', payeeId: 'p_globex', amount: '9500000000', note: DECEPTIVE_NOTE });
  }
  it('default: the CFO sees the spoofed headline and no mention of Globex', async () => {
    await requestGlobexPayment();
    const [p] = await pending();
    expect(p!.headline).toBe(DECEPTIVE_NOTE);
    expect([p!.headline, ...p!.lines].join(' ')).not.toMatch(/Globex/i); // everything the page renders
  });
  it('hardened: the headline is built from the ledger record and flags the unverified-looking payee; the note is labelled untrusted', async () => {
    process.env.DVAP_HARDEN = 'V8';
    const [p] = await pending();
    expect(p!.headline).toBe('PAY $9,500.00 TO GLOBEX TRADING (acct_globex)'); // verified was flipped by the V5 step above
    expect(p!.lines.join('\n')).toMatch(/Agent's note \(unverified text\): Initech/);
  });
});

describe('Chapter 2 end to end — impersonate, widen policy, spoof the approver', () => {
  let u: TestStack;
  beforeEach(async () => { delete process.env.DVAP_HARDEN; u = await withStack(); });
  afterEach(async () => { await u.teardown(); });

  async function chain() {
    const c = new Client({ name: 'globex', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(u.urls.mcp), {
      requestInit: { headers: { Authorization: `Bearer ${u.keys.portalToken}`, 'x-agent-id': u.keys.agentId } },
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]!.text;
      return { isError: Boolean(r.isError), text, json: r.isError ? undefined : JSON.parse(text) };
    };
    const policy = await call('configure_payment_policy', { allowPayees: ['p_globex'], trustPayees: ['p_globex'], perTxCap: '20000000000' });
    const pay = policy.isError ? undefined : await call('create_payment', { invoiceId: 'INV-2001', payeeId: 'p_globex', amount: '9500000000', note: DECEPTIVE_NOTE });
    await c.close();
    return { policy, pay };
  }

  it('default: Globex gets $9,500 after the CFO approves a screen that never mentions Globex', async () => {
    const before = await bal(u, 'acct_globex');
    const { pay } = await chain();
    expect(pay!.json.status).toBe('pending_approval');
    const shown = ((await (await fetch(`${u.urls.approval}/api/pending`)).json()).payments as { id: string; headline: string; lines: string[] }[])[0]!;
    expect([shown.headline, ...shown.lines].join(' ')).not.toMatch(/Globex/i);
    const ok = await cfoClick(u.urls.approval, shown.id); // the CFO clicks Approve
    expect(ok.status).toBe(200);
    expect(await bal(u, 'acct_globex')).toBe(before + 9_500_000_000);
    const audit = (await u.client.audit()).entries.map((e) => `${e.actor}:${e.action}`);
    expect(audit).toContain('agent-1:policy.updated'); // the audit trail blames the legitimate agent (V4)
  });

  it('hardened (V4+V5+V8): the chain dies at step one and nothing reaches the CFO', async () => {
    process.env.DVAP_HARDEN = 'V4,V5,V8';
    const before = await bal(u, 'acct_globex');
    const { policy, pay } = await chain();
    expect(policy.isError).toBe(true);
    expect(pay).toBeUndefined();
    expect(await bal(u, 'acct_globex')).toBe(before);
  });
});

describe('V29 — approval action not bound to the approver\'s session', () => {
  let u: TestStack;
  beforeEach(async () => { u = await withStack(); });
  afterEach(async () => { await u.teardown(); });

  const queue = async () => (await u.client.createPayment({ agentId: u.keys.agentId, invoiceId: 'INV-1001', payeeId: 'p_initech', amount: '1200000000' })).id;
  /** What a hostile web page in the CFO's browser (or an SSRF'd agent) can do: a blind cross-origin POST, no cookie, no token. */
  const blindPost = (id: string) =>
    fetch(`${u.urls.approval}/api/payments/${id}/sign`, { method: 'POST', headers: { origin: 'https://evil.example' } });

  it('default: a cross-origin POST with no credentials approves the payment (the bug)', async () => {
    const id = await queue();
    expect((await blindPost(id)).status).toBe(200);
    expect((await u.client.getPayment(id)).status).toBe('settled');
  });

  it('hardened: it is refused; the real page (cookie + token, same origin) still works', async () => {
    process.env.DVAP_HARDEN = 'V29';
    const id = await queue();
    expect((await blindPost(id)).status).toBe(403);
    expect((await u.client.getPayment(id)).status).toBe('pending_approval');

    const s = await fetch(`${u.urls.approval}/api/session`);
    const cookie = s.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf } = await s.json();
    const ok = await fetch(`${u.urls.approval}/api/payments/${id}/sign`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
    expect(ok.status).toBe(200);
    expect((await u.client.getPayment(id)).status).toBe('settled');
  });
});
