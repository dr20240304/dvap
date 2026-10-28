import type { Express, NextFunction, Request, Response } from 'express';
import { ASSET, NETWORK } from '../common/config';
import { b64json, parseB64json } from '../common/crypto';
import { hardened } from '../common/harden';
import {
  HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE,
  type PaymentPayload, type PaymentRequired, type Requirement, type SettleResponse, type VerifyResponse,
} from '../common/x402';

export interface PaidRouteConfig {
  amount: string;
  payTo: string;
  description: string;
  maxTimeoutSeconds?: number;
}

export interface PaywallDeps {
  facilitatorUrl: string;
  /** called after a payment settles, with the payer and the resource URL (the merchant's purchase history) */
  onPaid?: (payer: string, resource: string) => void;
}

async function facilitator<T>(deps: PaywallDeps, path: 'verify' | 'settle', body: unknown): Promise<T> {
  const res = await fetch(`${deps.facilitatorUrl}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`facilitator ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function challenge(req: Request, cfg: PaidRouteConfig, error?: string): PaymentRequired {
  const requirement: Requirement = {
    scheme: 'exact',
    network: NETWORK,
    amount: cfg.amount,
    asset: ASSET,
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? 60,
  };
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url: `${req.protocol}://${req.get('host')}${req.originalUrl}`, description: cfg.description, mimeType: 'application/json' },
    accepts: [requirement],
  };
}

function send402(req: Request, res: Response, cfg: PaidRouteConfig, error?: string) {
  const body = challenge(req, cfg, error);
  res.status(402).set(HEADER_REQUIRED, b64json(body)).json(body);
}

const HEADER_RECEIPT = 'x-payment-receipt';
const consumedReceipts = new Set<string>();

/**
 * "Pay first, claim later": a client that already settled a payment can present the transaction id instead of a signature.
 * V24: VULNERABLE BY DEFAULT — the server only checks that the transaction EXISTS. Not who was paid, how much, for which
 * resource, or whether it was already used. So a $0.25 receipt unlocks the $2 report, and unlocks it again and again.
 * DVAP_HARDEN=V24: the transfer must pay this route's payTo at least its price, carry this resource, and be single-use.
 */
async function claimReceipt<T>(
  req: Request, res: Response, cfg: PaidRouteConfig, deps: PaywallDeps, receipt: string, work: () => Promise<T> | T,
): Promise<{ data: T; settlement: SettleResponse } | null> {
  const r = await fetch(`${deps.facilitatorUrl}/transfer/${encodeURIComponent(receipt)}`);
  const t = r.ok ? ((await r.json()) as { id: string; to: string; amount: string; kind: string; memo: string }) : undefined;
  let ok = t !== undefined && t.kind === 'x402';
  if (ok && hardened('V24')) {
    ok = t!.to === cfg.payTo && Number(t!.amount) >= Number(cfg.amount) && t!.memo === `x402 ${resourceUrl(req)}`.slice(0, 200) && !consumedReceipts.has(receipt);
  }
  if (!ok) {
    send402(req, res, cfg, 'invalid_receipt');
    return null;
  }
  consumedReceipts.add(receipt);
  return { data: await work(), settlement: { success: true, transaction: receipt, network: NETWORK } };
}

const resourceUrl = (req: Request): string => `${req.protocol}://${req.get('host')}${req.originalUrl}`;

/**
 * Charge for a request: verify → (caller's work) → settle. Returns the settlement, or null after sending a 402/400.
 * `work` runs only after verify succeeds, and its errors never charge the buyer.
 */
async function charge<T>(
  req: Request, res: Response, cfg: PaidRouteConfig, deps: PaywallDeps, work: () => Promise<T> | T,
): Promise<{ data: T; settlement: SettleResponse } | null> {
  const header = req.header(HEADER_SIGNATURE);
  const receipt = req.header(HEADER_RECEIPT);
  if (!header && receipt) return claimReceipt(req, res, cfg, deps, receipt, work);
  if (!header) {
    send402(req, res, cfg);
    return null;
  }

  let payload: PaymentPayload;
  try {
    payload = parseB64json<PaymentPayload>(header);
  } catch {
    res.status(400).json({ error: 'malformed_payment_header' });
    return null;
  }
  const requirement = challenge(req, cfg).accepts[0]!;
  const body = { paymentPayload: payload, paymentRequirements: requirement, resourceUrl: resourceUrl(req) };

  // V16: the resource server must treat the facilitator's answer as authoritative and fail closed.
  // VULNERABLE BY DEFAULT: a facilitator error on /verify is treated as "fine" (fail-open), and a failed /settle still
  // releases the body. Anyone who can make verify blow up, or race the balance between verify and settle, gets free data.
  let v: VerifyResponse;
  try {
    v = await facilitator<VerifyResponse>(deps, 'verify', body);
  } catch (e) {
    if (hardened('V16')) throw e;
    v = { isValid: true };
  }
  if (!v.isValid) {
    send402(req, res, cfg, v.invalidReason ?? 'invalid_payment');
    return null;
  }

  const data = await work(); // errors here propagate before any settlement

  let settlement: SettleResponse;
  try {
    settlement = await facilitator<SettleResponse>(deps, 'settle', body);
  } catch (e) {
    if (hardened('V16')) throw e;
    settlement = { success: false, errorReason: 'settle_unreachable' };
  }
  if (!settlement.success && hardened('V16')) {
    send402(req, res, cfg, settlement.errorReason ?? 'settlement_failed'); // body withheld
    return null;
  }
  if (settlement.transaction) consumedReceipts.add(settlement.transaction); // a receipt already redeemed by its own request is spent
  if (settlement.success && settlement.payer) deps.onPaid?.(settlement.payer, resourceUrl(req));
  return { data, settlement };
}

/**
 * Register a paywalled GET route. The paywall is part of the route itself (gate == router), so there is no
 * second URL parser that can disagree with the framework. Handler runs only after verify; the response is
 * released only after settle succeeds; handler errors never charge the buyer.
 */
export function paidGet(app: Express, path: string, cfg: PaidRouteConfig, deps: PaywallDeps, handler: (req: Request) => Promise<unknown> | unknown): void {
  app.get(path, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await charge(req, res, cfg, deps, () => handler(req));
      if (out) res.set(HEADER_RESPONSE, b64json(out.settlement)).json(out.data);
    } catch (e) {
      next(e);
    }
  });
}

/**
 * Edge-style gate: charge in middleware, then hand the request to whatever router comes next.
 * This is the architecture that produced x402's gate/router parser-differential bugs (V15): the decision
 * "is this path paid?" is made by one parser, the routing by another.
 */
export async function gateRequest(req: Request, res: Response, cfg: PaidRouteConfig, deps: PaywallDeps): Promise<boolean> {
  const out = await charge(req, res, cfg, deps, () => true);
  if (!out) return false;
  res.set(HEADER_RESPONSE, b64json(out.settlement));
  res.locals.paid = out.settlement;
  return true;
}
