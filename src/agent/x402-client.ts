import { ASSET, NETWORK } from '../common/config';
import { b64json, parseB64json, randomHex, signMessage } from '../common/crypto';
import { hardened } from '../common/harden';
import { parseMicros } from '../common/money';
import {
  HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE,
  signingMessage, type Authorization, type PaymentPayload, type PaymentRequired, type Requirement, type SettleResponse,
} from '../common/x402';

export interface Signer {
  agentId: string;
  privateKey: string;
}

export interface ChallengePolicy {
  allowedPayTo: string[];
  maxAmountMicros: number;
}

/**
 * V20: reading the operator's price cap. MAX_PRICE_MICROS is documented in micro-USDC (1000000 = $1).
 * VULNERABLE BY DEFAULT: the value goes through `Number(x) * 1e6` — as if it were dollars — so "1000000" becomes a $1,000,000 cap,
 * and any value that is not a plain number ("$1", "1 USDC") becomes NaN, which compares false against every price: the cap silently
 * switches off. DVAP_HARDEN=V20: a strict positive integer of micro-USDC, or a startup error.
 */
export function parseMaxPrice(raw: string | undefined, fallback = 1_000_000): number {
  if (raw === undefined || raw === '') return fallback;
  if (!hardened('V20')) return Number(raw) * 1_000_000;
  return parseMicros(raw, 'MAX_PRICE_MICROS');
}

export interface PaidFetchResult {
  status: number;
  body: unknown;
  paid?: { amount: string; payTo: string; transaction?: string };
}

/**
 * The agent-side gate on a 402 challenge.
 * VULNERABLE BY DEFAULT (V7+): without DVAP_HARDEN=V7 the client signs whatever payee/amount the server asks for —
 * the same trust gap as x402's open "client pays the PAYMENT-REQUIRED it is handed" issues (public #3461).
 * Hardened: payee allowlist + max price + network/asset + resource-origin binding, checked before anything is signed.
 */
export function guardChallenge(requestedUrl: string, pr: PaymentRequired, req: Requirement, policy: ChallengePolicy): void {
  if (!hardened('V7')) return;
  if (req.network !== NETWORK || req.asset !== ASSET) throw new Error('challenge_rejected: unexpected network/asset');
  if (!policy.allowedPayTo.includes(req.payTo)) throw new Error(`challenge_rejected: payee ${req.payTo} is not on the allowlist`);
  if (parseMicros(req.amount) > policy.maxAmountMicros) throw new Error(`challenge_rejected: amount ${req.amount} exceeds max price`);
  if (new URL(pr.resource.url).origin !== new URL(requestedUrl).origin) throw new Error('challenge_rejected: resource origin mismatch');
}

/** Sign an authorization for `req` and return the PAYMENT-SIGNATURE header value. */
export function buildPaymentHeader(
  url: string, pr: PaymentRequired, req: Requirement, signer: Signer, now: () => number = () => Math.floor(Date.now() / 1000),
): string {
  const auth: Authorization = {
    from: signer.agentId,
    to: req.payTo,
    value: req.amount,
    validBefore: now() + Math.min(req.maxTimeoutSeconds, 60),
    nonce: randomHex(16),
    resource: url,
  };
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted: req,
    payload: { authorization: auth, signature: signMessage(signer.privateKey, signingMessage(req.network, req.asset, auth)) },
  };
  return b64json(payload);
}

export async function fetchPaid(
  url: string,
  signer: Signer,
  policy: ChallengePolicy,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<PaidFetchResult> {
  // V19: VULNERABLE BY DEFAULT — redirects are followed, and fetch forwards custom headers (unlike Authorization) across
  // origins, so a signed payment header travels to wherever the server points. DVAP_HARDEN=V19: never follow redirects.
  const redirect = hardened('V19') ? 'manual' : 'follow';
  const first = await fetch(url, { redirect });
  if (first.status !== 402) return { status: first.status, body: await readBody(first) };

  const raw = first.headers.get(HEADER_REQUIRED);
  if (!raw) throw new Error('402 without PAYMENT-REQUIRED header');
  const pr = parseB64json<PaymentRequired>(raw);
  const req = pr.accepts.find((a) => a.scheme === 'exact' && a.network === NETWORK);
  if (!req) throw new Error('no supported payment option in challenge');
  guardChallenge(url, pr, req, policy);

  const header = buildPaymentHeader(url, pr, req, signer, now);

  const second = await fetch(url, { redirect, headers: { [HEADER_SIGNATURE]: header } });
  const body = await readBody(second);
  if (second.status !== 200) return { status: second.status, body };
  const settle = second.headers.get(HEADER_RESPONSE) ? parseB64json<SettleResponse>(second.headers.get(HEADER_RESPONSE)!) : undefined;
  return { status: 200, body, paid: { amount: req.amount, payTo: req.payTo, transaction: settle?.transaction } };
}

async function readBody(res: Response): Promise<unknown> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
