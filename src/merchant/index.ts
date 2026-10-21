import express, { type Express } from 'express';
import { MERCHANT_ACCOUNT } from '../common/config';
import { errorHandler, HttpError } from '../common/errors';
import { dollars } from '../common/money';
import { hardened } from '../common/harden';
import { gateRequest, paidGet } from './paywall';

export interface VendorReport {
  vendorId: string;
  legalName: string;
  riskScore: number; // 0 (safe) … 100 (dangerous)
  sanctionsHit: boolean;
  bankAccountVerified: boolean;
  registeredYearsAgo: number;
  notes: string;
}

/** "VettingCo": the pay-per-call vendor-risk API PayPilot buys before paying an unfamiliar vendor. */
const REPORTS: Record<string, VendorReport> = {
  p_initech: { vendorId: 'p_initech', legalName: 'Initech Systems LLC', riskScore: 12, sanctionsHit: false, bankAccountVerified: true, registeredYearsAgo: 14, notes: 'Long-standing vendor; bank details unchanged for 3 years.' },
  p_hooli: { vendorId: 'p_hooli', legalName: 'Hooli Cloud Inc.', riskScore: 8, sanctionsHit: false, bankAccountVerified: true, registeredYearsAgo: 9, notes: 'Public company; no adverse records.' },
  p_globex: { vendorId: 'p_globex', legalName: 'Globex Trading Ltd', riskScore: 83, sanctionsHit: false, bankAccountVerified: false, registeredYearsAgo: 0, notes: 'Registered 4 months ago; bank details changed twice in 30 days.' },
};

export const VENDOR_CHECK_PRICE = dollars(0.25); // 250000 micro-USDC

export const PREMIUM_PRICE = dollars(2); // 2000000 micro-USDC

/** The "deep dive" sold at the premium tier: everything in the basic report plus data VettingCo charges extra for. */
const DEEP_DIVE: Record<string, { beneficialOwners: string[]; bankChangeHistory: string[]; internalAnalystNote: string }> = {
  p_initech: { beneficialOwners: ['Bill Lumbergh (60%)', 'Peter Gibbons (40%)'], bankChangeHistory: [], internalAnalystNote: 'No concerns.' },
  p_hooli: { beneficialOwners: ['Public float'], bankChangeHistory: [], internalAnalystNote: 'No concerns.' },
  p_globex: {
    beneficialOwners: ['Hank Scorpio (100%)'],
    bankChangeHistory: ['2026-09-02 changed to acct_globex_drop', '2026-09-30 changed to acct_globex'],
    internalAnalystNote: 'Shell-company pattern; do not pay without out-of-band bank verification.',
  },
};

const collapseSlashes = (p: string): string => p.replace(/\/{2,}/g, '/');

export interface MerchantConfig {
  facilitatorUrl: string;
}

export function createMerchantApp(cfg: MerchantConfig): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'merchant-api' }));

  const deps = { facilitatorUrl: cfg.facilitatorUrl };
  const premium = { amount: String(PREMIUM_PRICE), payTo: MERCHANT_ACCOUNT, description: 'Vendor deep-dive report (VettingCo premium)' };

  // --- Edge gate for the /v1/premium/ tier (V15) ---------------------------------------------------------
  // VULNERABLE BY DEFAULT: the gate decides "is this path paid?" with a case-sensitive regex on the RAW path, while the
  // router below is case-insensitive and sits behind a slash-collapsing rewrite. `//v1/premium/…` and `/V1/Premium/…`
  // are routed to the premium handler but never match the gate. (Same bug class as x402 GHSA-3j63-5h8p-gf7c.)
  // DVAP_HARDEN=V15: the gate tests the same normalised path the router sees, and the handler also requires proof of payment.
  app.use((req, res, next) => {
    const seen = hardened('V15') ? collapseSlashes(req.path).toLowerCase() : req.path;
    if (!/^\/v1\/premium\//.test(seen)) return next();
    gateRequest(req, res, premium, deps).then((ok) => ok && next(), next);
  });
  app.use((req, _res, next) => {
    req.url = collapseSlashes(req.url); // proxy-style path cleanup that happens AFTER the gate
    next();
  });

  app.get('/v1/premium/vendor-deep-dive/:vendorId', (req, res) => {
    if (hardened('V15') && !res.locals.paid) {
      res.status(402).json({ error: 'payment_required' }); // default-deny at the route, not only at the gate
      return;
    }
    const id = String(req.params.vendorId);
    const report = REPORTS[id];
    if (!report) throw new HttpError(404, 'unknown_vendor');
    res.json({ ...report, ...DEEP_DIVE[id] });
  });

  paidGet(
    app,
    '/v1/vendor-check/:vendorId',
    { amount: String(VENDOR_CHECK_PRICE), payTo: MERCHANT_ACCOUNT, description: 'Vendor risk report (VettingCo)' },
    deps,
    (req) => {
      const report = REPORTS[String(req.params.vendorId)];
      if (!report) throw new HttpError(404, 'unknown_vendor');
      return report;
    },
  );

  app.use(errorHandler);
  return app;
}
