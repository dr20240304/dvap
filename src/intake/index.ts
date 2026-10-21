import express, { type Express } from 'express';
import { errorHandler, HttpError } from '../common/errors';
import { LedgerClient } from '../common/ledgerClient';
import { parseInvoicePdf } from './parse';

/**
 * Acme's AP mailbox. Suppliers email invoice PDFs; this middleware extracts the text, files the invoice in the ledger,
 * and the agent later reads it like any other invoice. Anyone can send one: that is the point of an inbox.
 * The PDF's text, hidden or not, becomes the invoice memo (V3's delivery route). The fix is on the reading side: DVAP_HARDEN=V3.
 */
export function createIntakeApp(opts: { ledgerUrl: string; serviceKey: string }): Express {
  const ledger = new LedgerClient(opts.ledgerUrl, opts.serviceKey);
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'intake' }));
  app.post('/invoices/pdf', express.raw({ type: 'application/pdf', limit: '1mb' }), async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(415, 'pdf_required', 'send the invoice as application/pdf');
      let parsed;
      try {
        parsed = await parseInvoicePdf(req.body);
      } catch (e) {
        throw new HttpError(422, 'unreadable_invoice', e instanceof Error ? e.message : 'could not read the PDF');
      }
      const inv = await ledger.createInvoice({ id: parsed.id, vendor: parsed.vendor, amount: parsed.amount, memo: parsed.memo, dueDate: parsed.dueDate });
      res.status(201).json({ filed: inv.id, vendor: inv.payeeName, amount: inv.amount, memoChars: inv.memo.length });
    } catch (e) {
      next(e);
    }
  });
  app.use(errorHandler);
  return app;
}
