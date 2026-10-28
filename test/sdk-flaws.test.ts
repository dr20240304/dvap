import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { b64json, parseB64json, signMessage } from '../src/common/crypto';
import { AGENT_WALLET_ACCOUNT, ASSET, MERCHANT_ACCOUNT, NETWORK, PORTAL_AGENT_ID } from '../src/common/config';
import { HEADER_REQUIRED, HEADER_SIGNATURE, signingMessage, type Authorization, type PaymentPayload, type PaymentRequired } from '../src/common/x402';
import { createRogueMerchantApp } from '../src/attacker/rogue-merchant';
import { fetchPaid } from '../src/agent/x402-client';
import { listen, type RunningService } from '../src/common/service';
import { bal, withStack, type TestStack } from './helpers';

/**
 * Lessons from the x402 SDK advisory (The Hacker News, Oct 2026). Three flaws; DVAP already models the first as V7/V20/V6 (a client
 * that signs whatever 402 it is handed, no per-payment cap), so this file covers the two that were new:
 *   V33 — a facilitator that accepts a token *approval* as a payment
 *   V34 — a client that signs a "sign in with your wallet" message without checking which site it is for
 */
let t: TestStack;
let rogue: RunningService;
beforeAll(async () => {
  t = await withStack();
  rogue = await listen('rogue-merchant', createRogueMerchantApp({ facilitatorUrl: t.urls.facilitator, siwxTarget: t.urls.merchant }), 0);
});
afterAll(async () => {
  await rogue.close();
  await t.teardown();
});
beforeEach(() => { delete process.env.DVAP_HARDEN; });

const signer = () => ({ agentId: t.keys.agentId, privateKey: t.keys.agentPrivateKey });
const policy = { allowedPayTo: [MERCHANT_ACCOUNT], maxAmountMicros: 20_000_000 };

describe('V33 — approval accepted as payment', () => {
  const url = () => `${t.urls.merchant}/v1/vendor-check/p_initech`;

  /** Signed by the portal identity: a registered payer whose wallet holds nothing. `kind` is the instruction type. */
  async function payWith(kind: Authorization['kind']): Promise<Response> {
    const r0 = await fetch(url());
    const pr = parseB64json<PaymentRequired>(r0.headers.get(HEADER_REQUIRED)!);
    const req = pr.accepts[0]!;
    const auth: Authorization = {
      from: PORTAL_AGENT_ID, to: req.payTo, value: req.amount, validBefore: Math.floor(Date.now() / 1000) + 30,
      nonce: Math.random().toString(16).slice(2).padEnd(16, '0'), resource: url(), kind,
    };
    const p: PaymentPayload = { x402Version: 2, resource: pr.resource, accepted: req, payload: { authorization: auth, signature: signMessage(t.keys.agentPrivateKey, signingMessage(NETWORK, ASSET, auth)) } };
    return fetch(url(), { headers: { [HEADER_SIGNATURE]: b64json(p) } });
  }

  it('default: a signed approve unlocks the paid report with no balance and the merchant is never paid', async () => {
    const m = await bal(t, MERCHANT_ACCOUNT);
    const portal = await bal(t, 'acct_portal_wallet');
    const r = await payWith('approve');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { riskScore: number }).riskScore).toBe(12);
    expect(await bal(t, MERCHANT_ACCOUNT)).toBe(m);
    expect(await bal(t, 'acct_portal_wallet')).toBe(portal);
  });

  it('hardened: only a transfer is a payment; the approve is refused', async () => {
    process.env.DVAP_HARDEN = 'V33';
    const r = await payWith('approve');
    expect(r.status).toBe(402);
    expect(((await r.json()) as { error: string }).error).toBe('wrong_instruction');
  });

  it('an unknown instruction type is refused even by default', async () => {
    const r = await payWith('burn' as never);
    expect(r.status).toBe(402);
  });

  it('a real transfer still needs balance: the empty wallet cannot pay', async () => {
    process.env.DVAP_HARDEN = 'V33';
    const r = await payWith('transfer');
    expect(r.status).toBe(402);
    expect(((await r.json()) as { error: string }).error).toBe('insufficient_funds');
  });
});

describe('V34 — wallet login message signed without checking the site', () => {
  const vendorUrl = () => `${rogue.url}/v1/vendor-check/p_hooli`;

  it('control: signing in directly at the real site works and shows an empty history', async () => {
    const c = (await (await fetch(`${t.urls.merchant}/auth/siwx/challenge?address=${t.keys.agentId}`)).json()) as { message: string };
    const body = { message: c.message, signature: signMessage(t.keys.agentPrivateKey, c.message), address: t.keys.agentId };
    const login = await fetch(`${t.urls.merchant}/auth/siwx/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(login.status).toBe(200);
    // a message signed for one nonce cannot be replayed
    const again = await fetch(`${t.urls.merchant}/auth/siwx/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(again.status).toBe(401);
  });

  it('default: the agent signs the rogue merchant\'s login message and the attacker is signed in to the real site as the agent', async () => {
    const before = await bal(t, AGENT_WALLET_ACCOUNT);
    await fetchPaid(vendorUrl(), signer(), policy); // V7 is also open by default: the agent pays the rogue, too
    expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBeLessThan(before);
    const stolen = (await (await fetch(`${rogue.url}/relayed`)).json()) as { address: string; token: string; history: { address: string } }[];
    expect(stolen).toHaveLength(1);
    expect(stolen[0]!.address).toBe(t.keys.agentId);
    expect(stolen[0]!.history.address).toBe(t.keys.agentId);
    // the stolen session works at the real site
    const mine = await fetch(`${t.urls.merchant}/v1/account/history`, { headers: { authorization: `Bearer ${stolen[0]!.token}` } });
    expect(mine.status).toBe(200);
  });

  it('hardened: the agent refuses a login message that names another site, and signs nothing', async () => {
    process.env.DVAP_HARDEN = 'V34';
    const walletBefore = await bal(t, AGENT_WALLET_ACCOUNT);
    await expect(fetchPaid(vendorUrl(), signer(), policy)).rejects.toThrow(/siwx_rejected/);
    expect(await bal(t, AGENT_WALLET_ACCOUNT)).toBe(walletBefore);
    expect(await (await fetch(`${rogue.url}/relayed`)).json()).toHaveLength(1); // still just the one from the default-mode test
  });

  it('hardened: a login message for the site the agent is really talking to is still signed', async () => {
    process.env.DVAP_HARDEN = 'V34';
    const url = `${t.urls.merchant}/v1/vendor-check/p_hooli`;
    const c = (await (await fetch(`${t.urls.merchant}/auth/siwx/challenge?address=${t.keys.agentId}`)).json()) as { message: string };
    const { buildSignIn } = await import('../src/agent/x402-client');
    expect(() => buildSignIn(url, c.message, signer())).not.toThrow();
  });

  it('the merchant records the payer so the stolen session shows the victim\'s purchase history', async () => {
    delete process.env.DVAP_HARDEN;
    await fetchPaid(`${t.urls.merchant}/v1/vendor-check/p_hooli`, signer(), policy);
    const [s] = ((await (await fetch(`${rogue.url}/relayed`)).json()) as { token: string }[]).slice(-1);
    const h = (await (await fetch(`${t.urls.merchant}/v1/account/history`, { headers: { authorization: `Bearer ${s!.token}` } })).json()) as { purchases: string[] };
    expect(h.purchases.some((p) => p.includes('/v1/vendor-check/p_hooli'))).toBe(true);
  });
});
