import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { b64json, generateKeyPair, parseB64json, signMessage } from '../src/common/crypto';
import { ASSET, MERCHANT_ACCOUNT, NETWORK, AGENT_WALLET_ACCOUNT } from '../src/common/config';
import { HEADER_REQUIRED, HEADER_SIGNATURE, HEADER_RESPONSE, signingMessage, type Authorization, type PaymentPayload, type PaymentRequired } from '../src/common/x402';
import { fetchPaid, guardChallenge } from '../src/agent/x402-client';
import { bal, withStack, type TestStack } from './helpers';

let t: TestStack;
beforeAll(async () => { t = await withStack(); });
afterAll(async () => { await t.teardown(); });
beforeEach(() => { delete process.env.DVAP_HARDEN; });

const url = () => `${t.urls.merchant}/v1/vendor-check/p_initech`;
const signer = () => ({ agentId: t.keys.agentId, privateKey: t.keys.agentPrivateKey });
const policy = { allowedPayTo: [MERCHANT_ACCOUNT], maxAmountMicros: 1_000_000 };

async function getChallenge(): Promise<PaymentRequired> {
  const r = await fetch(url());
  expect(r.status).toBe(402);
  return parseB64json<PaymentRequired>(r.headers.get(HEADER_REQUIRED)!);
}

function build(pr: PaymentRequired, over: Partial<Authorization> = {}, key = t.keys.agentPrivateKey): PaymentPayload {
  const req = pr.accepts[0]!;
  const auth: Authorization = { from: 'agent-1', to: req.payTo, value: req.amount, validBefore: Math.floor(Date.now() / 1000) + 30, nonce: Math.random().toString(16).slice(2).padEnd(16, '0'), ...over };
  return { x402Version: 2, resource: pr.resource, accepted: req, payload: { authorization: auth, signature: signMessage(key, signingMessage(NETWORK, ASSET, auth)) } };
}
const pay = (p: PaymentPayload) => fetch(url(), { headers: { [HEADER_SIGNATURE]: b64json(p) } });

describe('paywall', () => {
  it('answers 402 with a well-formed PAYMENT-REQUIRED challenge', async () => {
    const pr = await getChallenge();
    expect(pr.accepts[0]).toMatchObject({ scheme: 'exact', network: NETWORK, asset: ASSET, amount: '250000', payTo: MERCHANT_ACCOUNT });
  });

  it('does not leak the paid body in the 402', async () => {
    const r = await fetch(url());
    expect(JSON.stringify(await r.json())).not.toContain('riskScore');
  });

  it('valid payment → 200, settlement header, balances move exactly once', async () => {
    const pr = await getChallenge();
    const w = await bal(t, AGENT_WALLET_ACCOUNT);
    const m = await bal(t, MERCHANT_ACCOUNT);
    const p = build(pr);
    const r = await pay(p);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { riskScore: number }).riskScore).toBe(12);
    expect(parseB64json<{ success: boolean }>(r.headers.get(HEADER_RESPONSE)!).success).toBe(true);
    expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBe(w - 250000);
    expect(await bal(t, MERCHANT_ACCOUNT)).toBe(m + 250000);
    // replaying the identical payment is refused and costs nothing
    const again = await pay(p);
    expect(again.status).toBe(402);
    expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBe(w - 250000);
  });

  it('a handler error (unknown vendor) does not charge the buyer', async () => {
    const r0 = await fetch(`${t.urls.merchant}/v1/vendor-check/nope`);
    const pr = parseB64json<PaymentRequired>(r0.headers.get(HEADER_REQUIRED)!);
    const w = await bal(t, AGENT_WALLET_ACCOUNT);
    const r = await fetch(`${t.urls.merchant}/v1/vendor-check/nope`, { headers: { [HEADER_SIGNATURE]: b64json(build(pr)) } });
    expect(r.status).toBe(404);
    expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBe(w);
  });
});

describe('facilitator rejects bad payments (and no money moves)', () => {
  const cases: [string, (pr: PaymentRequired) => PaymentPayload][] = [
    ['wrong signer key', (pr) => build(pr, {}, generateKeyPair().privateKey)],
    ['tampered amount (signed for less)', (pr) => build(pr, { value: '1' })],
    ['paying a different payee', (pr) => build(pr, { to: 'acct_globex' })],
    ['expired authorization', (pr) => build(pr, { validBefore: Math.floor(Date.now() / 1000) - 5 })],
    ['validity window far beyond maxTimeout', (pr) => build(pr, { validBefore: Math.floor(Date.now() / 1000) + 10 * 365 * 86400 })],
    ['unknown payer', (pr) => build(pr, { from: 'agent-evil' })],
    ['short nonce', (pr) => build(pr, { nonce: 'abc' })],
  ];
  for (const [name, make] of cases) {
    it(name, async () => {
      if (name.startsWith('validity window')) process.env.DVAP_HARDEN = 'V21'; // bounded window is the V21 fix; unbounded is the default bug
      const pr = await getChallenge();
      const w = await bal(t, AGENT_WALLET_ACCOUNT);
      const r = await pay(make(pr));
      delete process.env.DVAP_HARDEN;
      expect(r.status).toBe(402);
      expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBe(w);
    });
  }

  it('malformed header → 400, not 402', async () => {
    const r = await fetch(url(), { headers: { [HEADER_SIGNATURE]: '%%%not-base64-json' } });
    expect(r.status).toBe(400);
  });

  it('payload signed over a different amount than the merchant requires is refused even if self-consistent', async () => {
    const pr = await getChallenge();
    const cheaper = structuredClone(pr);
    cheaper.accepts[0]!.amount = '1';
    const r = await pay(build(cheaper)); // internally consistent at 1 µUSDC, but merchant requires 250000
    expect(r.status).toBe(402);
  });
});

describe('agent x402 client', () => {
  it('pays a legitimate 402 and returns the body + receipt', async () => {
    const res = await fetchPaid(url(), signer(), policy);
    expect(res.status).toBe(200);
    expect(res.paid?.amount).toBe('250000');
    expect(res.paid?.transaction).toMatch(/^tx_/);
  });

  it('hardened (V19): does not follow redirects (payment header must not travel)', async () => {
    process.env.DVAP_HARDEN = 'V19';
    const http = await import('node:http');
    const srv = http.createServer((_q, s) => { s.writeHead(302, { location: 'http://evil.invalid/' }); s.end(); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const res = await fetchPaid(`http://127.0.0.1:${port}/x`, signer(), policy);
    expect(res.status).toBe(302);
    srv.close();
  });

  describe('challenge guard (V7): vulnerable by default, hardened with DVAP_HARDEN=V7', () => {
    const evil = (over: Partial<PaymentRequired['accepts'][0]>): [PaymentRequired, PaymentRequired['accepts'][0]] => {
      const req = { scheme: 'exact' as const, network: NETWORK, amount: '250000', asset: ASSET, payTo: MERCHANT_ACCOUNT, maxTimeoutSeconds: 60, ...over };
      return [{ x402Version: 2, resource: { url: 'http://127.0.0.1:1/x', description: 'd', mimeType: 'application/json' }, accepts: [req] }, req];
    };
    it('default: unpinned payee and inflated price are accepted (the bug)', () => {
      const [pr, req] = evil({ payTo: 'acct_attacker', amount: '99000000' });
      expect(() => guardChallenge('http://127.0.0.1:1/x', pr, req, policy)).not.toThrow();
    });
    it('hardened: payee swap, price inflation, asset/network swap and origin mismatch are rejected', () => {
      process.env.DVAP_HARDEN = 'V7';
      for (const over of [{ payTo: 'acct_attacker' }, { amount: '99000000' }, { asset: 'EVIL' }, { network: 'other:net' }]) {
        const [pr, req] = evil(over);
        expect(() => guardChallenge('http://127.0.0.1:1/x', pr, req, policy)).toThrow(/challenge_rejected/);
      }
      const [pr, req] = evil({});
      expect(() => guardChallenge('http://127.0.0.1:1/x', pr, req, policy)).not.toThrow();
      expect(() => guardChallenge('http://other.example/x', pr, req, policy)).toThrow(/origin mismatch/);
    });
  });
});
