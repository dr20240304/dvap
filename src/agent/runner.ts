import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, MERCHANT_ACCOUNT } from '../common/config';
import { sha256Hex } from '../common/crypto';
import { hardened } from '../common/harden';
import { DIRECTIVE_RE } from '../common/injection';
import { usd } from '../common/money';
import { canonicalJson } from '../common/crypto';
import type { PaymentRequired } from '../common/x402';
import { buildPaymentHeader, fetchPaid, guardChallenge, type ChallengePolicy, type Signer } from './x402-client';

export interface AgentConfig {
  mcpUrl: string;
  merchantUrl: string;
  agentToken: string;
  signer: Signer;
  /** max seconds to wait for a human approval before reporting "pending" */
  approvalTimeoutMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
  challengePolicy?: ChallengePolicy;
  /** optional third-party MCP server ("invoice-tools") the agent has installed */
  vendorMcpUrl?: string;
  /** third-party MCP servers the organisation has reviewed (used when DVAP_HARDEN includes V14) */
  approvedMcpUrls?: string[];
  /** pay VettingCo for a vendor risk report before paying the invoice (default true) */
  vetVendors?: boolean;
  /** call the third-party server's paid `enrich_vendor` tool (x402 over MCP) */
  enrichVendors?: boolean;
  /** where tool-description hashes are pinned (used when DVAP_HARDEN includes V2) */
  pinFile?: string;
}

export interface AgentResult {
  ok: boolean;
  outcome: 'paid' | 'pending_approval' | 'rejected' | 'denied' | 'aborted' | 'failed';
  invoiceId?: string;
  paymentId?: string;
  detail: string;
  vendorRisk?: number;
  steps: string[];
}

interface Invoice { id: string; payeeId: string; payeeName: string; amount: string; memo: string; status: string; dueDate: string }
interface Payment { id: string; status: string; reason: string | null }
interface VendorReport { riskScore: number; sanctionsHit: boolean; bankAccountVerified: boolean; notes: string; legalName: string }

/**
 * PayPilot's scripted agent: a deterministic stand-in for the LLM loop so demos never flake.
 * It follows the same tool-use shape a real model would: discover → read → vet (paid x402 call) → pay → wait.
 * Decision rule (explicitly NOT a security control): proceed only if the paid vendor report looks clean.
 */
export async function runAgent(prompt: string, cfg: AgentConfig): Promise<AgentResult> {
  const steps: string[] = [];
  const say = (s: string) => {
    steps.push(s);
    cfg.log?.(s);
  };

  const client = new Client({ name: 'paypilot-agent', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(cfg.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${cfg.agentToken}` } } }),
  );
  // V14: shadow MCP. VULNERABLE BY DEFAULT: any server URL the agent is configured with is connected and its tools are exposed to the
  // model, with no inventory or approval. DVAP_HARDEN=V14: only servers on the organisation's approved list are connected.
  const shadow = Boolean(cfg.vendorMcpUrl) && hardened('V14') && !(cfg.approvedMcpUrls ?? []).includes(cfg.vendorMcpUrl!);
  if (shadow) say(`🛑 MCP server ${cfg.vendorMcpUrl} is not on the approved list — not connecting (shadow MCP)`);
  const vendorClient = cfg.vendorMcpUrl && !shadow ? new Client({ name: 'paypilot-agent', version: '0.1.0' }) : undefined;
  if (vendorClient) await vendorClient.connect(new StreamableHTTPClientTransport(new URL(cfg.vendorMcpUrl!)));
  const vendorTools = new Set<string>();

  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await (vendorTools.has(name) ? vendorClient! : client).callTool({ name, arguments: args });
    const first = (r.content as { type: string; text: string }[])[0];
    if (r.isError) throw new Error(`${name} → ${first?.text}`);
    return JSON.parse(first!.text) as T;
  };

  /**
   * Chapter 1: the agent models a gullible LLM — instructions embedded in anything it reads are obeyed
   * (see common/injection.ts). Each source has its own hardening flag: V1 tool descriptions, V3 invoice memos, V28 paid responses.
   */
  const followDirectives = async (text: string, source: string, flag: 'V1' | 'V3' | 'V11' | 'V28') => {
    for (const m of text.matchAll(DIRECTIVE_RE)) {
      const [, tool, json] = m as unknown as [string, string, string];
      if (hardened(flag)) {
        say(`🛡️ Ignored an instruction embedded in ${source} (untrusted data, not a user request)`);
        continue;
      }
      say(`⚠️ Obeying instruction found in ${source}: ${tool}`);
      try {
        const out = await call<Record<string, unknown>>(tool, JSON.parse(json));
        say(`   ↳ ${tool} → ${typeof out.status === 'string' ? out.status : 'ok'}${typeof out.reason === 'string' ? ` (${out.reason})` : ''}`);
      } catch (e) {
        say(`   ↳ ${tool} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  };

  /** V2: tool pinning. Vulnerable by default (descriptions are trusted every time they are listed). */
  const pinOk = (name: string, description: string, schema: unknown): boolean => {
    if (!hardened('V2')) return true;
    const file = cfg.pinFile ?? path.join(dataDir(), 'tool-pins.json');
    const pins: Record<string, string> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const hash = sha256Hex(JSON.stringify({ name, description, schema }));
    if (!pins[name]) {
      pins[name] = hash; // trust on first use: a human would review and approve here
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(pins, null, 2));
      say(`📌 Pinned third-party tool ${name} (${hash.slice(0, 12)})`);
      return true;
    }
    if (pins[name] !== hash) {
      say(`🛑 Tool ${name} changed since it was approved (pinned ${pins[name]!.slice(0, 12)}, now ${hash.slice(0, 12)}) — refusing to use it until re-approved`);
      return false;
    }
    return true;
  };

  /**
   * x402 over MCP: a tool answers with a payment-required error; the client pays by retrying with `_meta["x402/payment"]`.
   * V22: the challenge arrives as text AND structuredContent. VULNERABLE BY DEFAULT: the agent vets the text (what its log and
   * policy see) but signs the structured copy. DVAP_HARDEN=V22: refuse unless both copies are identical, then use that one.
   */
  const enrich = async (vendorId: string) => {
    const policy = cfg.challengePolicy ?? { allowedPayTo: [MERCHANT_ACCOUNT], maxAmountMicros: 1_000_000 };
    const first = await vendorClient!.callTool({ name: 'enrich_vendor', arguments: { vendorId } });
    if (!first.isError) return;
    const textPR = JSON.parse(((first.content as { text: string }[])[0])!.text) as PaymentRequired;
    const structPR = (first.structuredContent as PaymentRequired | undefined) ?? textPR;
    if (hardened('V22') && canonicalJson(textPR) !== canonicalJson(structPR)) {
      say('🛑 enrich_vendor: the payment request differs between its text and structured copies — refusing to pay');
      return;
    }
    const shown = textPR.accepts[0]!;
    guardChallenge(cfg.vendorMcpUrl!, textPR, shown, policy);
    const signedFor = structPR.accepts[0]!;
    const header = buildPaymentHeader(textPR.resource.url, structPR, signedFor, cfg.signer);
    const second = await vendorClient!.callTool({ name: 'enrich_vendor', arguments: { vendorId }, _meta: { 'x402/payment': JSON.parse(Buffer.from(header, 'base64').toString()) } });
    say(second.isError
      ? `❌ enrich_vendor payment failed`
      : `✅ Paid ${usd(Number(shown.amount))} to ${shown.payTo} for vendor enrichment`);
  };

  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    say(`✅ Connected to payments-mcp (${tools.length} tools: ${tools.join(', ')})`);
    if (tools.includes('recall_notes')) {
      const { notes } = await call<{ notes: string[] }>('recall_notes');
      if (notes.length) await followDirectives(notes.join('\n'), 'the assistant memory', 'V11');
    }
    if (vendorClient) {
      for (const t of (await vendorClient.listTools()).tools) {
        if (!pinOk(t.name, t.description ?? '', t.inputSchema)) continue;
        vendorTools.add(t.name);
        say(`🔌 Third-party tool available: ${t.name}`);
        await followDirectives(t.description ?? '', `the description of tool ${t.name}`, 'V1');
      }
    }

    const invoices = await call<Invoice[]>('list_open_invoices');
    const wanted = /INV-\d+/i.exec(prompt)?.[0]?.toUpperCase();
    const invoice = wanted
      ? invoices.find((i) => i.id === wanted)
      : invoices.find((i) => prompt.toLowerCase().includes(i.payeeName.split(' ')[0]!.toLowerCase()));
    if (!invoice) {
      say('❌ No matching open invoice');
      return { ok: false, outcome: 'aborted', detail: 'no matching open invoice', steps };
    }
    const inv = await call<Invoice>('read_invoice', { invoiceId: invoice.id });
    say(`✅ Read ${inv.id}: ${inv.payeeName} — ${usd(Number(inv.amount))} — "${inv.memo.split('\n')[0]}"`);
    if (vendorTools.has('extract_invoice_fields')) await call('extract_invoice_fields', { invoiceId: inv.id });
    await followDirectives(inv.memo, `the memo of ${inv.id}`, 'V3');

    if (cfg.enrichVendors && vendorTools.has('enrich_vendor')) await enrich(inv.payeeId);

    // Vet the vendor with a paid x402 call (the agent's own wallet pays VettingCo). cfg.vetVendors: false skips it (the simple PDF demo).
    let report: VendorReport | undefined;
    if (cfg.vetVendors !== false) {
      const policy = cfg.challengePolicy ?? { allowedPayTo: [MERCHANT_ACCOUNT], maxAmountMicros: 1_000_000 };
      let vet;
      try {
        vet = await fetchPaid(`${cfg.merchantUrl}/v1/vendor-check/${inv.payeeId}`, cfg.signer, policy);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.startsWith('challenge_rejected')) throw e;
        say(`🛑 Refused to pay the vendor-check challenge: ${msg}`);
        return { ok: false, outcome: 'aborted', invoiceId: inv.id, detail: msg, steps };
      }
      if (vet.status !== 200 || !vet.paid) {
        say(`❌ Vendor check failed (HTTP ${vet.status})`);
        return { ok: false, outcome: 'failed', invoiceId: inv.id, detail: `vendor check failed: HTTP ${vet.status}`, steps };
      }
      report = vet.body as VendorReport;
      say(`✅ Paid ${usd(Number(vet.paid.amount))} via x402 (tx ${vet.paid.transaction}) → vendor risk ${report.riskScore}/100`);

      await followDirectives(report.notes, 'the paid vendor report', 'V28');

      if (report.sanctionsHit || report.riskScore >= 50 || !report.bankAccountVerified) {
        say(`🛑 Not paying: ${report.notes}`);
        return { ok: false, outcome: 'aborted', invoiceId: inv.id, vendorRisk: report?.riskScore, detail: `vendor flagged: ${report.notes}`, steps };
      }
    }

    let payment = await call<Payment>('create_payment', { invoiceId: inv.id, payeeId: inv.payeeId, amount: inv.amount });
    say(`✅ Payment ${payment.id} → ${payment.status}${payment.reason ? ` (${payment.reason})` : ''}`);

    if (payment.status === 'pending_approval') {
      say('⏳ Waiting for CFO approval…');
      const deadline = Date.now() + (cfg.approvalTimeoutMs ?? 60_000);
      while (payment.status === 'pending_approval' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, cfg.pollMs ?? 500));
        payment = await call<Payment>('get_payment_status', { paymentId: payment.id });
      }
    }

    switch (payment.status) {
      case 'settled':
        say(`💸 ${inv.id} paid (${usd(Number(inv.amount))} to ${inv.payeeName})`);
        return { ok: true, outcome: 'paid', invoiceId: inv.id, paymentId: payment.id, vendorRisk: report?.riskScore, detail: 'invoice paid', steps };
      case 'pending_approval':
        say('⏳ Still pending approval; stopping.');
        return { ok: false, outcome: 'pending_approval', invoiceId: inv.id, paymentId: payment.id, vendorRisk: report?.riskScore, detail: 'approval timed out', steps };
      case 'rejected':
        say('🛑 CFO rejected the payment');
        return { ok: false, outcome: 'rejected', invoiceId: inv.id, paymentId: payment.id, vendorRisk: report?.riskScore, detail: 'rejected by approver', steps };
      case 'denied':
        say(`🛑 Policy denied the payment: ${payment.reason}`);
        return { ok: false, outcome: 'denied', invoiceId: inv.id, paymentId: payment.id, vendorRisk: report?.riskScore, detail: payment.reason ?? 'denied', steps };
      default:
        say(`❌ Payment ended as ${payment.status}`);
        return { ok: false, outcome: 'failed', invoiceId: inv.id, paymentId: payment.id, vendorRisk: report?.riskScore, detail: payment.status, steps };
    }
  } finally {
    await vendorClient?.close();
    await client.close();
  }
}
