import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { canonicalJson, randomHex, sha256Hex, signMessage, timingSafeEqualStr } from '../common/crypto';
import { hostGuard } from '../common/hostGuard';
import { errorHandler, HttpError } from '../common/errors';
import { hardened } from '../common/harden';
import { LedgerClient, type PaymentDto } from '../common/ledgerClient';
import { usd } from '../common/money';

export interface ApprovalUiConfig {
  ledgerUrl: string;
  serviceKey: string;
  cfoPrivateKey: string; // the CFO's signing key (ed25519): held by this service only, like a wallet; the agent never sees it
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PayPilot — CFO approve and sign</title>
<style>
  :root{--bg:#0f1420;--card:#171e2e;--fg:#e8ecf4;--mut:#93a0b8;--ok:#3ecf8e;--bad:#ff6b6b;--warn:#ffb454;--line:#263048}
  @media (prefers-color-scheme: light){:root{--bg:#f4f6fb;--card:#fff;--fg:#141a29;--mut:#5b6780;--line:#dfe4ef}}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
  header{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}
  .banner{background:var(--warn);color:#1a1200;padding:6px 24px;font-weight:600;font-size:13px}
  main{max-width:760px;margin:24px auto;padding:0 16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
  .row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .amt{font-size:22px;font-weight:700}
  .mut{color:var(--mut);font-size:13px}
  .tx{font:12px ui-monospace,Menlo,monospace;color:var(--mut);margin-top:6px;word-break:break-all}
  button{border:0;border-radius:8px;padding:8px 16px;font-weight:600;cursor:pointer;margin-right:8px}
  .ok{background:var(--ok);color:#052} .no{background:var(--bad);color:#300}
  .empty{color:var(--mut);text-align:center;padding:32px}
</style></head>
<body>
<div class="banner">DVAP — intentionally vulnerable demo. Fictional money.</div>
<header><strong>PayPilot · CFO approve and sign</strong><span class="mut" id="who">Dana Whitfield (CFO) · signing key held here</span></header>
<main><div id="list"><div class="empty">Loading…</div></div></main>
<script>
const list = document.getElementById('list');
const usd = (m) => '$' + (Number(m)/1e6).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6});
function el(tag, attrs, ...kids){const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs||{}))e[k]=v;for(const c of kids)e.append(c);return e}
async function act(id, verb){
  const { csrf } = await (await fetch('/api/session')).json();
  const r = await fetch('/api/payments/'+encodeURIComponent(id)+'/'+verb,{method:'POST',headers:{'x-csrf-token':csrf}});
  if(!r.ok){const j=await r.json().catch(()=>({}));alert(verb+' failed: '+(j.error||r.status))}
  load();
}
async function load(){
  const r = await fetch('/api/pending'); const data = await r.json();
  list.replaceChildren();
  if(!data.payments.length){list.append(el('div',{className:'empty'},'No payments waiting for your approval and signature.'));return}
  for(const p of data.payments){
    const card = el('div',{className:'card'},
      el('div',{className:'row'}, el('div',{className:'amt'},usd(p.amount)), el('div',{className:'mut'},p.id)),
      el('div',{}, el('strong',{},p.headline)),
      ...p.lines.map((l)=>el('div',{className:'mut'},l)),
      el('div',{className:'mut'},'Requested by '+p.requestedBy+' · policy: '+(p.reason||'—')+' · '+p.createdAt),
      el('div',{className:'tx'},'You are signing transaction '+p.digest),
      el('div',{style:'margin-top:12px'},
        el('button',{className:'ok',onclick:()=>act(p.id,'sign')},'Approve & sign'),
        el('button',{className:'no',onclick:()=>act(p.id,'reject')},'Reject')));
    list.append(card);
  }
}
load(); setInterval(load, 2000);
</script></body></html>`;

/**
 * The approval screen is rendered from the ledger's own record of the payment (payee, invoice, amount) —
 * never from text supplied by the agent. All values are inserted with textContent, not HTML.
 */
/**
 * What the CFO reads before approving and signing.
 * V8: VULNERABLE BY DEFAULT — the headline is the agent's own summary ("note"); the payee the ledger will actually pay is not shown.
 * DVAP_HARDEN=V8: the headline is built only from the ledger's record (payee, account, verification, amount); the agent's note
 * is shown last, labelled untrusted.
 */
export function describePayment(p: PaymentDto, payee: { accountId: string; verified: boolean } | undefined): { headline: string; lines: string[] } {
  const base = `Requested by ${p.requestedBy} · invoice ${p.invoiceId} · policy: ${p.reason ?? '—'}`;
  if (!hardened('V8')) return { headline: p.note ?? `Pay ${p.payeeName}`, lines: [base] };
  const acct = payee ? `${payee.accountId}${payee.verified ? '' : ' — UNVERIFIED PAYEE'}` : 'unknown account';
  return {
    headline: `PAY ${usd(Number(p.amount))} TO ${p.payeeName.toUpperCase()} (${acct})`,
    lines: [base, `Transfer: ${usd(Number(p.amount))} USDC from the operating account to ${payee?.accountId ?? 'unknown account'}`, ...(p.note ? [`Agent's note (unverified text): ${p.note}`] : [])],
  };
}

export function createApprovalUiApp(cfg: ApprovalUiConfig): Express {
  const ledger = new LedgerClient(cfg.ledgerUrl, cfg.serviceKey);
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard);
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'approval-ui' }));
  app.get('/', (_req, res) => res.type('html').set('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'").send(PAGE));

  app.get('/api/pending', (_req, res, next) => {
    Promise.all([ledger.listPayments('pending_approval'), ledger.listPayees()])
      .then(async ([r, payees]) => res.json({
        payments: await Promise.all(r.payments.map(async (p) => ({ ...p, digest: (await ledger.paymentTransaction(p.id)).digest, ...describePayment(p, payees.payees.find((x) => x.id === p.payeeId)) }))),
      }), next);
  });

  /**
   * V29: VULNERABLE BY DEFAULT — approve/reject are not bound to the CFO's browser session. Any page or process that can reach
   * this port can POST an approval (cross-site request, DNS rebinding, an SSRF'd agent). The "human in the loop" is a URL.
   * DVAP_HARDEN=V29: actions need the session cookie AND a per-session token (readable only same-origin), and a matching Origin.
   */
  const secret = randomHex(32);
  const csrfFor = (sid: string) => sha256Hex(`${secret}:${sid}`);
  const sidOf = (req: Request) => /(?:^|;\s*)dvap_sid=([0-9a-f]+)/.exec(req.header('cookie') ?? '')?.[1];
  app.get('/api/session', (req, res) => {
    let sid = sidOf(req);
    if (!sid) {
      sid = randomHex(16);
      res.setHeader('set-cookie', `dvap_sid=${sid}; HttpOnly; SameSite=Strict; Path=/`);
    }
    res.json({ csrf: csrfFor(sid) });
  });
  const bound = (req: Request, _res: Response, next: NextFunction) => {
    if (!hardened('V29')) return next();
    const origin = req.header('origin');
    if (origin && new URL(origin).host !== req.header('host')) return next(new HttpError(403, 'bad_origin'));
    const sid = sidOf(req);
    const token = req.header('x-csrf-token');
    if (!sid || !token || !timingSafeEqualStr(token, csrfFor(sid))) return next(new HttpError(403, 'session_binding_failed'));
    next();
  };

  const idParam = z.string().regex(/^pay_[0-9a-f]+$/);
  /** The CFO's click signs the payment's transaction with the CFO's key (as a wallet would) and sends the signature to the ledger. */
  app.post('/api/payments/:id/sign', bound, (req, res, next) => {
    const id = idParam.parse(req.params.id);
    ledger.paymentTransaction(id)
      .then((t) => ledger.signPayment(id, 'cfo', signMessage(cfg.cfoPrivateKey, t.message)))
      .then((p) => res.json(p), next);
  });
  app.post('/api/payments/:id/reject', bound, (req, res, next) => {
    const id = idParam.parse(req.params.id);
    ledger.rejectPayment(id, 'cfo', signMessage(cfg.cfoPrivateKey, canonicalJson({ action: 'reject', payment: id })), 'rejected by CFO').then((p) => res.json(p), next);
  });

  app.use(errorHandler);
  return app;
}
