import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ASSET, NETWORK } from '../common/config';
import { hardened } from '../common/harden';
import { verifyMessage } from '../common/crypto';
import { errorHandler, HttpError } from '../common/errors';
import { LedgerClient } from '../common/ledgerClient';
import { parseMicros } from '../common/money';
import { signingMessage, type PaymentPayload, type Requirement, type SettleResponse, type VerifyResponse } from '../common/x402';

const bodySchema = z.object({
  paymentPayload: z.any(),
  paymentRequirements: z.any(),
  resourceUrl: z.string().optional(), // the URL the resource server is actually serving
});

export interface FacilitatorConfig {
  ledgerUrl: string;
  serviceKey: string;
  now?: () => number; // unix seconds
}

export function createFacilitatorApp(cfg: FacilitatorConfig): Express {
  const ledger = new LedgerClient(cfg.ledgerUrl, cfg.serviceKey);
  const now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  /** Pure checks of a payment against what the resource server asked for. Never trusts the payload's own claims. */
  async function verify(payload: PaymentPayload, req: Requirement, resourceUrl?: string): Promise<VerifyResponse & { agentWallet?: string }> {
    const bad = (invalidReason: string): VerifyResponse => ({ isValid: false, invalidReason });
    if (payload?.x402Version !== 2) return bad('unsupported_version');
    if (req.scheme !== 'exact' || payload.accepted?.scheme !== 'exact') return bad('unsupported_scheme');
    if (req.network !== NETWORK || payload.accepted.network !== NETWORK) return bad('wrong_network');
    if (req.asset !== ASSET || payload.accepted.asset !== ASSET) return bad('wrong_asset');
    const a = payload.payload?.authorization;
    if (!a || typeof payload.payload.signature !== 'string') return bad('malformed_payload');
    if (a.to !== req.payTo || payload.accepted.payTo !== req.payTo) return bad('payto_mismatch');
    let want: number;
    let got: number;
    try {
      want = parseMicros(req.amount);
      got = parseMicros(a.value);
    } catch {
      return bad('invalid_amount');
    }
    if (got !== want) return bad('amount_mismatch'); // strict equality — never `>=`
    const t = now();
    if (typeof a.validBefore !== 'number' || a.validBefore <= t) return bad('expired');
    // V21: the authorization's validity window must be short. VULNERABLE BY DEFAULT: only "not yet expired" is checked, so a payment
    // signed for years in the future stays replayable (and a leaked header stays a bearer instrument). DVAP_HARDEN=V21: bound it.
    if (hardened('V21') && a.validBefore > t + req.maxTimeoutSeconds) return bad('validity_window_too_long');
    if (typeof a.nonce !== 'string' || a.nonce.length < 16) return bad('invalid_nonce');
    let agent;
    try {
      agent = await ledger.getAgent(a.from);
    } catch {
      return bad('unknown_payer');
    }
    // V18: a payment must be bound to the resource it was signed for. Vulnerable by default — a payment signed for
    // one URL is accepted for any other URL with the same price/payee (x402 public issues #162, #1388, #3838).
    if (hardened('V18') && (a.resource !== resourceUrl || payload.resource?.url !== resourceUrl)) return bad('resource_mismatch');
    if (!verifyMessage(agent.publicKey, signingMessage(req.network, req.asset, a), payload.payload.signature)) return bad('invalid_signature');
    if ((await ledger.nonceUsed(a.nonce)).used) return bad('nonce_already_used');
    const bal = Number((await ledger.getAccount(agent.walletAccount)).balance);
    if (bal < want) return bad('insufficient_funds');
    return { isValid: true, payer: agent.id, agentWallet: agent.walletAccount };
  }

  const route = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req).then((out) => res.json(out), next);
  };

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'facilitator' }));
  app.get('/supported', (_req, res) => res.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK, asset: ASSET }] }));

  /** Receipt lookup for resource servers (V24). Read-only view of a settled transfer. */
  app.get('/transfer/:id', (req, res, next) => {
    ledger.getTransfer(String(req.params.id)).then((t) => res.json(t), next);
  });

  app.post('/verify', route(async (req) => {
    const { paymentPayload, paymentRequirements, resourceUrl } = bodySchema.parse(req.body);
    const { agentWallet: _w, ...out } = await verify(paymentPayload, paymentRequirements, resourceUrl);
    return out;
  }));

  app.post('/settle', route(async (req): Promise<SettleResponse> => {
    const { paymentPayload, paymentRequirements, resourceUrl } = bodySchema.parse(req.body);
    // Always re-verify at settle: a verify result is never trusted across the verify→settle gap.
    const v = await verify(paymentPayload, paymentRequirements, resourceUrl);
    if (!v.isValid || !v.agentWallet) return { success: false, errorReason: v.invalidReason ?? 'verification_failed' };
    const a = (paymentPayload as PaymentPayload).payload.authorization;
    // V25: the facilitator sponsors the network fee. VULNERABLE BY DEFAULT: the sponsor pays for every settlement ATTEMPT that
    // passed verification, including ones that then fail (balance races, caps), so a caller can drain the sponsor with no payment
    // landing. DVAP_HARDEN=V25: the payer is charged the fee inside the same atomic transfer; failed attempts cost the sponsor nothing.
    if (!hardened('V25')) {
      try {
        await ledger.sponsorFee();
      } catch (e) {
        if (e instanceof HttpError) return { success: false, errorReason: e.code };
        throw e;
      }
    }
    try {
      const { transaction } = await ledger.transfer({
        payFee: hardened('V25'),
        from: v.agentWallet,
        to: (paymentRequirements as Requirement).payTo,
        amount: (paymentRequirements as Requirement).amount,
        nonce: a.nonce,
        memo: `x402 ${(paymentPayload as PaymentPayload).resource.url}`.slice(0, 200),
      });
      return { success: true, transaction, network: NETWORK, payer: v.payer };
    } catch (e) {
      // V17: a second settle of an already-settled authorization must FAIL. VULNERABLE BY DEFAULT: it is reported as
      // success ("idempotent"), so N concurrent requests carrying one payment header each get served while the buyer pays once.
      if (e instanceof HttpError && e.code === 'nonce_used' && !hardened('V17')) {
        return { success: true, transaction: 'already-settled', network: NETWORK, payer: v.payer };
      }
      if (e instanceof HttpError) return { success: false, errorReason: e.code };
      throw e;
    }
  }));

  app.use(errorHandler);
  return app;
}
