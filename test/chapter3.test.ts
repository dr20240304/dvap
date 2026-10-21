import http from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRogueMerchantApp, ROGUE_PRICE } from '../src/attacker/rogue-merchant';
import { createMerchantApp } from '../src/merchant';
import { runAgent } from '../src/agent/runner';
import { fetchPaid } from '../src/agent/x402-client';
import { AGENT_WALLET_ACCOUNT, ATTACKER_ACCOUNT, MERCHANT_ACCOUNT } from '../src/common/config';
import { b64json, parseB64json } from '../src/common/crypto';
import { listen, type RunningService } from '../src/common/service';
import { HEADER_REQUIRED, HEADER_SIGNATURE, type PaymentRequired } from '../src/common/x402';
import { bal, withStack, type TestStack } from './helpers';

let t: TestStack;
let rogue: RunningService;
beforeAll(async () => {
  t = await withStack();
  rogue = await listen('rogue', createRogueMerchantApp({ facilitatorUrl: t.urls.facilitator }), 0);
});
afterAll(async () => { await rogue.close(); await t.teardown(); });
beforeEach(() => { delete process.env.DVAP_HARDEN; });

const signer = () => ({ agentId: t.keys.agentId, privateKey: t.keys.agentPrivateKey });
const policy = { allowedPayTo: [MERCHANT_ACCOUNT], maxAmountMicros: 1_000_000 };

/** Raw HTTP request that sends the path byte-for-byte (fetch/URL would normalise `//`). */
function rawGet(base: string, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

describe('V15 — paywall route-gate bypass', () => {
  const normal = '/v1/premium/vendor-deep-dive/p_globex';
  const bypasses = ['//v1/premium/vendor-deep-dive/p_globex', '/V1/Premium/vendor-deep-dive/p_globex', '/v1//premium//vendor-deep-dive/p_globex'];

  it('control: the normal premium path is paywalled', async () => {
    expect((await rawGet(t.urls.merchant, normal)).status).toBe(402);
  });

  it('default: path variants skip the gate and return paid data for free (the bug)', async () => {
    const before = await bal(t, MERCHANT_ACCOUNT);
    for (const p of bypasses) {
      const r = await rawGet(t.urls.merchant, p);
      expect(r.status, p).toBe(200);
      expect(JSON.parse(r.body).internalAnalystNote).toMatch(/Shell-company/);
    }
    expect(await bal(t, MERCHANT_ACCOUNT)).toBe(before); // nothing was charged
  });

  it('hardened: every variant is paywalled again', async () => {
    process.env.DVAP_HARDEN = 'V15';
    for (const p of [normal, ...bypasses]) expect((await rawGet(t.urls.merchant, p)).status, p).toBe(402);
  });

  it('hardened: a legitimate payment still unlocks the premium data and is charged once', async () => {
    process.env.DVAP_HARDEN = 'V15';
    const before = await bal(t, MERCHANT_ACCOUNT);
    const r = await fetchPaid(`${t.urls.merchant}${normal}`, signer(), { allowedPayTo: [MERCHANT_ACCOUNT], maxAmountMicros: 2_000_000 });
    expect(r.status).toBe(200);
    expect(r.paid?.amount).toBe('2000000');
    expect(await bal(t, MERCHANT_ACCOUNT)).toBe(before + 2_000_000);
  });
});

describe('V7+ — agent signs whatever 402 it is handed (rogue merchant)', () => {
  const globex = 'Pay the Globex invoice INV-2001';

  it('default: the agent pays the attacker $15, accepts the forged report, and tries to pay Globex (ledger policy is the only thing left)', async () => {
    const walletBefore = await bal(t, AGENT_WALLET_ACCOUNT);
    const attackerBefore = await bal(t, ATTACKER_ACCOUNT);
    const r = await runAgent(globex, t.agentConfig({ merchantUrl: rogue.url, challengePolicy: policy }));
    expect(await bal(t, ATTACKER_ACCOUNT)).toBe(attackerBefore + Number(ROGUE_PRICE));
    expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBe(walletBefore - Number(ROGUE_PRICE));
    expect(r.vendorRisk).toBe(4); // forged "clean" report flipped the agent's decision
    expect(r.outcome).toBe('denied'); // Globex is not on the mandate allowlist — Chapter 2 breaks that next
  });

  it('hardened: the agent refuses the challenge and no money moves', async () => {
    process.env.DVAP_HARDEN = 'V7';
    const walletBefore = await bal(t, AGENT_WALLET_ACCOUNT);
    const attackerBefore = await bal(t, ATTACKER_ACCOUNT);
    const r = await runAgent(globex, t.agentConfig({ merchantUrl: rogue.url, challengePolicy: policy }));
    expect(r.outcome).toBe('aborted');
    expect(r.detail).toMatch(/challenge_rejected/);
    expect(await bal(t, ATTACKER_ACCOUNT)).toBe(attackerBefore);
    expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBe(walletBefore);
  });
});

describe('V18 — payment not bound to the resource', () => {
  const urlFor = (id: string) => `${t.urls.merchant}/v1/vendor-check/${id}`;

  /** A payment the agent signed for p_initech, intercepted before the merchant used it. */
  async function captureHeaderFor(id: string): Promise<string> {
    let captured = '';
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h[HEADER_SIGNATURE]) { captured = h[HEADER_SIGNATURE]; return new Response('{}', { status: 500 }); }
      return real(input, init);
    }) as typeof fetch;
    try { await fetchPaid(urlFor(id), signer(), policy); } finally { globalThis.fetch = real; }
    return captured;
  }

  it('default: a payment signed for one vendor report is accepted for another (the bug)', async () => {
    const header = await captureHeaderFor('p_initech');
    const r = await fetch(urlFor('p_globex'), { headers: { [HEADER_SIGNATURE]: header } });
    expect(r.status).toBe(200);
    expect((await r.json()).vendorId).toBe('p_globex');
  });

  it('hardened: the same replay is refused with resource_mismatch', async () => {
    process.env.DVAP_HARDEN = 'V18';
    const header = await captureHeaderFor('p_initech');
    const r = await fetch(urlFor('p_globex'), { headers: { [HEADER_SIGNATURE]: header } });
    expect(r.status).toBe(402);
    expect(parseB64json<PaymentRequired>(r.headers.get(HEADER_REQUIRED)!).error).toBe('resource_mismatch');
    // …and the honest payment for the right resource still works
    expect((await fetchPaid(urlFor('p_initech'), signer(), policy)).status).toBe(200);
  });
});

describe('V19 — payer follows redirects with its payment header', () => {
  async function scenario() {
    const seen: string[] = [];
    const sinkApp = express();
    sinkApp.get('*', (req, res) => {
      seen.push(String(req.header(HEADER_SIGNATURE) ?? ''));
      res.json({ sunk: true });
    });
    const sink = await listen('sink', sinkApp, 0);
    const pr: PaymentRequired = {
      x402Version: 2, resource: { url: 'http://x/', description: 'd', mimeType: 'application/json' },
      accepts: [{ scheme: 'exact', network: 'dvap:local', amount: '250000', asset: 'USDC', payTo: MERCHANT_ACCOUNT, maxTimeoutSeconds: 60 }],
    };
    const redirector = http.createServer((req, res) => {
      if (!req.headers[HEADER_SIGNATURE]) { res.writeHead(402, { [HEADER_REQUIRED]: b64json(pr) }); return void res.end('{}'); }
      res.writeHead(307, { location: `${sink.url}/collector` }); res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(redirector.address() as { port: number }).port}/x`;
    return { url, seen, close: async () => { redirector.close(); await sink.close(); } };
  }

  it('default: the signed header reaches a third-party origin', async () => {
    const s = await scenario();
    await fetchPaid(s.url, signer(), policy);
    expect(s.seen.filter(Boolean).length).toBe(1);
    await s.close();
  });

  it('hardened: nothing is forwarded', async () => {
    process.env.DVAP_HARDEN = 'V19';
    const s = await scenario();
    const r = await fetchPaid(s.url, signer(), policy);
    expect(r.status).toBe(307);
    expect(s.seen.filter(Boolean).length).toBe(0);
    await s.close();
  });
});

/** Capture `n` distinct signed payments (fresh nonce each) for `url` without letting the merchant see them. */
async function captureHeaders(url: string, n: number): Promise<string[]> {
  const out: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    if (h[HEADER_SIGNATURE]) { out.push(h[HEADER_SIGNATURE]); return new Response('{}', { status: 500 }); }
    return real(input, init);
  }) as typeof fetch;
  try {
    for (let i = 0; i < n; i++) await fetchPaid(url, signer(), { allowedPayTo: [MERCHANT_ACCOUNT], maxAmountMicros: 5_000_000 });
  } finally { globalThis.fetch = real; }
  return out;
}

describe('V16 — resource server ignores / fails open on the facilitator', () => {
  const premium = () => `${t.urls.merchant}/v1/premium/vendor-deep-dive/p_globex`;

  async function overdraft() {
    const wallet = await bal(t, AGENT_WALLET_ACCOUNT);
    const n = Math.floor(wallet / 2_000_000) + 4;
    const headers = await captureHeaders(premium(), n);
    const before = await bal(t, MERCHANT_ACCOUNT);
    const rs = await Promise.all(headers.map((h) => fetch(premium(), { headers: { [HEADER_SIGNATURE]: h } })));
    const served = rs.filter((r) => r.status === 200).length;
    return { n, affordable: Math.floor(wallet / 2_000_000), served, paid: (await bal(t, MERCHANT_ACCOUNT)) - before };
  }

  it('default: payments the wallet cannot cover still get the data (settle failure ignored)', async () => {
    const r = await overdraft();
    expect(r.served).toBe(r.n);
    expect(r.paid).toBe(r.affordable * 2_000_000);
    expect(r.served).toBeGreaterThan(r.affordable);
  });

  it('hardened: only settled payments are served', async () => {
    process.env.DVAP_HARDEN = 'V16';
    const r = await overdraft();
    expect(r.served).toBe(r.affordable);
    expect(r.paid).toBe(r.affordable * 2_000_000);
  });

  it('default: a facilitator outage fails open; hardened it fails closed', async () => {
    const dead = await listen('dead-merchant', createMerchantApp({ facilitatorUrl: 'http://127.0.0.1:1' }), 0);
    try {
      const header = b64json({ x402Version: 2, junk: true });
      const go = () => fetch(`${dead.url}/v1/vendor-check/p_globex`, { headers: { [HEADER_SIGNATURE]: header } });
      expect((await go()).status).toBe(200);
      process.env.DVAP_HARDEN = 'V16';
      expect((await go()).status).toBe(500);
    } finally { await dead.close(); }
  });
});

describe('V17 — duplicate settlement reported as success', () => {
  const url = () => `${t.urls.merchant}/v1/vendor-check/p_globex`;

  async function replayBurst() {
    const [header] = await captureHeaders(url(), 1);
    const before = await bal(t, MERCHANT_ACCOUNT);
    const rs = await Promise.all(Array.from({ length: 8 }, () => fetch(url(), { headers: { [HEADER_SIGNATURE]: header! } })));
    return { served: rs.filter((r) => r.status === 200).length, paid: (await bal(t, MERCHANT_ACCOUNT)) - before };
  }

  it('default: one payment header buys many responses (the bug)', async () => {
    process.env.DVAP_HARDEN = 'V16'; // isolate V17 from V16's lenient settle handling
    const r = await replayBurst();
    expect(r.paid).toBe(250_000);
    expect(r.served).toBeGreaterThan(1);
  });

  it('hardened: exactly one response per payment', async () => {
    process.env.DVAP_HARDEN = 'V16,V17';
    const r = await replayBurst();
    expect(r.paid).toBe(250_000);
    expect(r.served).toBe(1);
  });
});

describe('V22 — MCP payment-required result: text says one thing, structuredContent another', () => {
  // own stack: earlier tests in this file drain the shared agent wallet
  let u: TestStack;
  beforeEach(async () => { u = await withStack(); });
  afterEach(async () => { await u.teardown(); });
  async function enrichRun() {
    await fetch(u.urls.vendorMcp.replace(/\/mcp$/, '/control/mode'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'benign' }) });
    const before = { drop: await bal(u, ATTACKER_ACCOUNT), vet: await bal(u, MERCHANT_ACCOUNT) };
    const r = await runAgent('Pay the Hooli invoice', u.agentConfig({ vendorMcpUrl: u.urls.vendorMcp, enrichVendors: true, approvalTimeoutMs: 300 }));
    return { r, drop: (await bal(u, ATTACKER_ACCOUNT)) - before.drop, vet: (await bal(u, MERCHANT_ACCOUNT)) - before.vet };
  }

  it('default: the log says $0.25 to VettingCo; the signature pays the attacker $1.00 (the bug)', async () => {
    const { r, drop } = await enrichRun();
    expect(r.steps.join('\n')).toMatch(/Paid \$0\.25 to acct_vettingco for vendor enrichment/);
    expect(drop).toBe(1_000_000);
  });

  it('hardened: mismatching copies are refused and nothing is paid', async () => {
    process.env.DVAP_HARDEN = 'V22';
    const { r, drop } = await enrichRun();
    expect(r.steps.join('\n')).toMatch(/differs between its text and structured copies/);
    expect(drop).toBe(0);
  });
});

describe('V6 — the x402 spend cap lives only in the system prompt', () => {
  let u: TestStack;
  beforeEach(async () => { u = await withStack(); });
  afterEach(async () => { await u.teardown(); });

  /** A runaway loop (or an injected "keep checking") buying $2 reports ten times against a $5/day budget. */
  async function loop() {
    const url = `${u.urls.merchant}/v1/premium/vendor-deep-dive/p_globex`;
    const before = await bal(u, AGENT_WALLET_ACCOUNT);
    for (let i = 0; i < 10; i++) {
      await fetchPaid(url, { agentId: u.keys.agentId, privateKey: u.keys.agentPrivateKey }, { allowedPayTo: [MERCHANT_ACCOUNT], maxAmountMicros: 5_000_000 });
    }
    return before - (await bal(u, AGENT_WALLET_ACCOUNT));
  }

  it('default: the wallet is spent far past the promised $5/day', async () => {
    expect(await loop()).toBe(10 * 2_000_000);
  });

  it('hardened: the ledger stops at the budget', async () => {
    process.env.DVAP_HARDEN = 'V6,V16'; // V16 so the refused settle is not served anyway
    expect(await loop()).toBe(4_000_000); // two $2 purchases fit; the third would reach $6
  });
});
