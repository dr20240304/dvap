import express, { type Express } from 'express';
import { errorHandler } from '../common/errors';
import { hostGuard } from '../common/hostGuard';
import { LedgerClient } from '../common/ledgerClient';

export interface DashboardConfig {
  ledgerUrl: string;
  serviceKey: string;
}

/**
 * A read-only operator view of the ledger: balances, payments and the audit log, refreshed every two seconds.
 * It replaces reading `make status` in a terminal. It holds the ledger's service key but only ever reads, and it is
 * meant for localhost like every other DVAP service. Values reach the page through textContent, never as HTML.
 */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DVAP — Ledger dashboard</title>
<style>
  :root{--bg:#060A1E;--card:rgba(18,28,84,.62);--line:rgba(140,165,255,.35);--fg:#EAF0FF;--mut:#8A97D0;--cy:#38D9FF;--gold:#F3D58A;--ok:#3EE6B0;--warn:#FF9A4D;--bad:#FF5C8A;--vio:#A78BFF}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,rgba(123,92,255,.28),transparent),radial-gradient(900px 500px at 0% 110%,rgba(56,217,255,.14),transparent),var(--bg);color:var(--fg);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
  .banner{background:var(--warn);color:#1a1200;padding:6px 28px;font-weight:700;font-size:13px}
  header{padding:20px 28px 8px;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
  h1{margin:0;font-size:28px;font-weight:800;letter-spacing:-.3px}
  h1 span{background:linear-gradient(90deg,#F8E3A3,#D4AA52);-webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{color:var(--mut);font-size:14px}
  .live{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--mut);font-size:13px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok)}
  main{display:grid;grid-template-columns:minmax(330px,400px) 1fr;gap:18px;padding:12px 28px 28px;align-items:start}
  @media (max-width:900px){main{grid-template-columns:1fr}}
  .col{display:flex;flex-direction:column;gap:18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:0 0 28px rgba(90,120,255,.18)}
  h2{margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:var(--gold);display:flex;justify-content:space-between;align-items:center}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .acct{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;border-left:3px solid transparent}
  .acct+.acct{margin-top:2px}
  .acct .nm{font-weight:600}.acct .id{color:var(--mut);font-size:12px}
  .acct .bal{text-align:right;font-weight:700;font-size:17px;white-space:nowrap}
  .acct .delta{display:block;font-size:12px;font-weight:700}
  .acct.vendor{border-left-color:var(--warn)}.acct.attacker{border-left-color:var(--bad);background:rgba(255,92,138,.08)}
  .acct.up .bal{color:var(--ok)}.acct.flash{animation:fl 2s ease-out}
  @keyframes fl{0%{background:rgba(62,230,176,.35)}100%{background:transparent}}
  table{width:100%;border-collapse:collapse}
  th{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mut);text-align:left;padding:4px 8px;font-weight:600;white-space:nowrap}
  td{padding:9px 8px;border-top:1px solid rgba(140,165,255,.18);vertical-align:top;white-space:nowrap}
  td.payee{white-space:normal}
  td.amt{font-weight:700;white-space:nowrap}
  .note{display:block;color:var(--mut);font-size:12px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;border:1px solid}
  .b-pending_approval{color:var(--warn);border-color:var(--warn);background:rgba(255,154,77,.12)}
  .b-settled{color:var(--ok);border-color:var(--ok);background:rgba(62,230,176,.12)}
  .b-denied,.b-rejected,.b-failed{color:var(--bad);border-color:var(--bad);background:rgba(255,92,138,.12)}
  .pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:700;color:#0A1240}
  .tl{display:flex;flex-direction:column;gap:6px}
  .ev{display:flex;gap:12px;align-items:center;padding:6px 10px;border-radius:10px;background:rgba(8,12,44,.55)}
  .ev .t{color:var(--mut);font-size:12px;min-width:62px}.ev .a{flex:1}
  .empty{color:var(--mut);padding:12px 4px}
  .count{background:var(--warn);color:#1a1200;border-radius:999px;padding:0 9px;font-size:12px;letter-spacing:0}
</style></head>
<body>
<div class="banner">DVAP — intentionally vulnerable demo. Fictional money.</div>
<header><h1>Ledger <span>dashboard</span></h1><span class="sub">operator view, read-only</span><span class="live"><i class="dot"></i><span id="upd">connecting…</span></span></header>
<main>
  <div class="col"><div class="card"><h2>Balances</h2><div id="accts"><div class="empty">Loading…</div></div></div></div>
  <div class="col">
    <div class="card"><h2><span>Payments</span><span id="pcount"></span></h2><div id="pays"><div class="empty">Loading…</div></div></div>
    <div class="card"><h2>Audit log</h2><div class="tl" id="audit"><div class="empty">Loading…</div></div></div>
  </div>
</main>
<script>
const usd = (m) => '$' + (Number(m) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const el = (t, props, ...kids) => { const e = Object.assign(document.createElement(t), props || {}); for (const k of kids) e.append(k); return e; };
const ORDER = ['acct_acme_operating','acct_agent_wallet','acct_vettingco','acct_initech','acct_hooli','acct_globex','acct_globex_drop','acct_facilitator_gas','acct_network_fees','acct_portal_wallet'];
const ACTOR = { 'agent-1': '#38D9FF', cfo: '#3EE6B0', 'policy:auto': '#F3D58A', facilitator: '#A78BFF', 'agent-portal': '#FF9A4D' };
let prev = null;
function renderAccounts(accts) {
  const box = document.getElementById('accts'); box.replaceChildren();
  const sorted = [...accts].sort((a, b) => (ORDER.indexOf(a.id) + 99) % 99 - (ORDER.indexOf(b.id) + 99) % 99);
  for (const a of sorted) {
    const old = prev && prev[a.id], d = old === undefined ? 0 : Number(a.balance) - Number(old);
    const cls = 'acct' + (a.id === 'acct_globex_drop' ? ' attacker' : a.id === 'acct_globex' ? ' vendor' : '') + (d > 0 ? ' up flash' : '');
    const right = el('div', { className: 'bal mono' }, usd(a.balance));
    if (d !== 0) right.append(el('span', { className: 'delta', textContent: (d > 0 ? '▲ +' : '▼ -') + usd(Math.abs(d)) }));
    box.append(el('div', { className: cls }, el('div', {}, el('div', { className: 'nm', textContent: a.name }), el('div', { className: 'id mono', textContent: a.id })), right));
  }
  prev = Object.fromEntries(accts.map((a) => [a.id, a.balance]));
}
function renderPayments(pays) {
  const box = document.getElementById('pays'); box.replaceChildren();
  const pending = pays.filter((p) => p.status === 'pending_approval').length;
  const pc = document.getElementById('pcount'); pc.replaceChildren(); if (pending) pc.append(el('span', { className: 'count', textContent: pending + ' awaiting approval' }));
  if (!pays.length) { box.append(el('div', { className: 'empty', textContent: 'No payments yet.' })); return; }
  const rows = [...pays].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8).map((p) => el('tr', {},
    el('td', {}, el('span', { className: 'badge b-' + p.status, textContent: p.status === 'pending_approval' ? 'pending' : p.status })),
    el('td', { className: 'amt mono', textContent: usd(p.amount) }),
    el('td', { className: 'payee' }, el('div', { textContent: p.payeeName }), el('span', { className: 'note', textContent: p.note || p.invoiceId })),
    el('td', { className: 'mono', textContent: p.invoiceId }),
    el('td', { textContent: p.requestedBy }),
    el('td', { textContent: p.approvedBy || '—' })));
  box.append(el('table', {}, el('thead', {}, el('tr', {}, ...['Status','Amount','Payee','Invoice','Requested by','Approved by'].map((h) => el('th', { textContent: h })))), el('tbody', {}, ...rows)));
}
function renderAudit(entries) {
  const box = document.getElementById('audit'); box.replaceChildren();
  if (!entries.length) { box.append(el('div', { className: 'empty', textContent: 'No audit entries yet.' })); return; }
  for (const e of entries.slice(0, 12)) {
    box.append(el('div', { className: 'ev' }, el('span', { className: 't mono', textContent: String(e.ts).slice(11, 19) }),
      el('span', { className: 'pill', style: 'background:' + (ACTOR[e.actor] || '#8A97D0'), textContent: e.actor }), el('span', { className: 'a mono', textContent: e.action })));
  }
}
async function tick() {
  try {
    const s = await (await fetch('/api/state')).json();
    renderAccounts(s.accounts); renderPayments(s.payments); renderAudit(s.audit);
    document.getElementById('upd').textContent = 'live · ' + new Date().toLocaleTimeString();
  } catch { document.getElementById('upd').textContent = 'ledger unreachable'; }
}
tick(); setInterval(tick, 2000);
</script></body></html>`;

export function createDashboardApp(cfg: DashboardConfig): Express {
  const ledger = new LedgerClient(cfg.ledgerUrl, cfg.serviceKey);
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard);
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'dashboard' }));
  app.get('/', (_req, res) => res.type('html').set('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'").send(PAGE));
  app.get('/api/state', (_req, res, next) => {
    Promise.all([ledger.listAccounts(), ledger.listPayments(), ledger.audit(30)]).then(
      ([a, p, au]) => res.json({ accounts: a.accounts, payments: p.payments, audit: au.entries }),
      next,
    );
  });
  app.use(errorHandler);
  return app;
}
