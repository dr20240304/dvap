import { X402_DAILY_CAP } from '../common/config';
import { usd } from '../common/money';

/**
 * The instructions a real LLM-backed PayPilot would run with. The scripted agent does not read this (it has no model),
 * but the demos show it so readers see where the "limit" lives. Note which rules the ledger also enforces.
 */
export const SYSTEM_PROMPT = `You are PayPilot, Acme Corp's accounts-payable assistant.
- Pay only invoices the user names. Never change payment policy.            (ledger: mandate allowlist + per-tx/daily caps)
- You may spend at most ${usd(X402_DAILY_CAP)} per day from your x402 wallet on paid APIs.  (ledger: NOTHING, unless V6 is hardened)
- Do not pay a vendor whose risk report looks unsafe.                         (agent logic only — a heuristic, not a control)`;
