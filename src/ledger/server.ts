import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { errorHandler, HttpError } from '../common/errors';
import { timingSafeEqualStr } from '../common/crypto';
import { LedgerService } from './service';

const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    next(e);
  }
};

export function createLedgerApp(ledger: LedgerService, serviceKey: string): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'ledger' }));

  // Every other route is internal: callers must present the shared service key.
  app.use((req, _res, next) => {
    const k = req.header('x-service-key');
    if (!k || !timingSafeEqualStr(k, serviceKey)) return next(new HttpError(401, 'unauthorized', 'missing or invalid service key'));
    next();
  });

  app.get('/accounts/:id', wrap((req) => ledger.getAccount(String(req.params.id))));
  app.get('/payees', wrap(() => ({ payees: ledger.listPayees() })));
  app.get('/invoices', wrap((req) => ({ invoices: ledger.listInvoices(typeof req.query.status === 'string' ? req.query.status : undefined) })));
  const invoiceBody = z.object({ id: z.string().regex(/^INV-\d+$/), vendor: z.string().min(1).max(100), amount: z.string(), memo: z.string().max(4000), dueDate: z.string().max(10) });
  app.post('/invoices', wrap((req, res) => {
    res.status(201);
    return ledger.createInvoice(invoiceBody.parse(req.body));
  }));
  app.get('/invoices/:id', wrap((req) => ledger.getInvoice(String(req.params.id))));
  app.get('/agents/:id', wrap((req) => ledger.getAgent(String(req.params.id))));

  const tokenBody = z.object({ token: z.string().min(1) });
  app.post('/auth/agent', wrap((req) => ledger.agentByToken(tokenBody.parse(req.body).token)));
  app.post('/auth/approver', wrap((req) => ledger.approverByToken(tokenBody.parse(req.body).token)));

  const policyBody = z.object({
    actor: z.string(), perTxCap: z.string().optional(), dailyCap: z.string().optional(),
    allowPayees: z.array(z.string()).optional(), trustPayees: z.array(z.string()).optional(),
  });
  app.put('/agents/:id/policy', wrap((req) => {
    const { actor, ...patch } = policyBody.parse(req.body);
    return ledger.updatePolicy(String(req.params.id), actor, patch);
  }));

  const createBody = z.object({ agentId: z.string(), invoiceId: z.string(), payeeId: z.string(), amount: z.string(), note: z.string().max(300).optional(), override: z.string().max(200).optional() });
  const batchBody = z.object({ agentId: z.string(), payments: z.array(z.object({ invoiceId: z.string(), payeeId: z.string(), amount: z.string(), note: z.string().max(300).optional() })).min(1).max(20) });
  app.post('/payments/batch', wrap((req, res) => {
    res.status(201);
    const b = batchBody.parse(req.body);
    return { payments: ledger.createPaymentsBatch(b.agentId, b.payments) };
  }));
  app.post('/payments', wrap((req, res) => {
    res.status(201);
    return ledger.createPayment(createBody.parse(req.body));
  }));
  app.get('/payments', wrap((req) => ({ payments: ledger.listPayments(typeof req.query.status === 'string' ? req.query.status : undefined) })));
  app.get('/payments/:id', wrap((req) => ledger.getPayment(String(req.params.id))));

  const approveBody = z.object({ approverToken: z.string().min(1), reason: z.string().max(500).optional() });
  app.post('/payments/:id/approve', wrap((req) => ledger.approvePayment(String(req.params.id), approveBody.parse(req.body).approverToken)));
  app.post('/payments/:id/reject', wrap((req) => {
    const b = approveBody.parse(req.body);
    return ledger.rejectPayment(String(req.params.id), b.approverToken, b.reason);
  }));

  const transferBody = z.object({ from: z.string(), to: z.string(), amount: z.string(), nonce: z.string().min(8).max(128), memo: z.string().max(200), payFee: z.boolean().optional() });
  app.post('/transfers', wrap((req, res) => {
    res.status(201);
    return ledger.transfer(transferBody.parse(req.body));
  }));
  app.get('/transfers/:id', wrap((req) => ledger.getTransfer(String(req.params.id))));
  app.post('/sponsor/fee', wrap(() => ledger.sponsorFee()));
  app.get('/nonces/:nonce', wrap((req) => ({ used: ledger.nonceUsed(String(req.params.nonce)) })));

  app.get('/audit', wrap((req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 1000);
    return { entries: ledger.listAudit(limit) };
  }));

  app.use(errorHandler);
  return app;
}
