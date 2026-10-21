/**
 * Deterministic payment policy — NO LLM in this path. This is the control that matters most:
 * limits enforced in code next to the money, not in a prompt.
 */
export interface Mandate {
  perTxCap: number;
  dailyCap: number;
  approvalThreshold: number;
  allowedPayees: string[];
}

export interface PolicyInput {
  amount: number;
  payeeId: string;
  payeeVerified: boolean;
  spentToday: number;
  mandate: Mandate;
}

export type PolicyDecision =
  | { decision: 'allow' }
  | { decision: 'approval_required'; reason: string }
  | { decision: 'deny'; reason: string };

export function evaluatePolicy(i: PolicyInput): PolicyDecision {
  if (!i.mandate.allowedPayees.includes(i.payeeId)) return { decision: 'deny', reason: 'payee_not_in_mandate_allowlist' };
  if (!i.payeeVerified) return { decision: 'deny', reason: 'payee_not_verified' };
  if (i.amount > i.mandate.perTxCap) return { decision: 'deny', reason: 'exceeds_per_transaction_cap' };
  if (i.spentToday + i.amount > i.mandate.dailyCap) return { decision: 'deny', reason: 'exceeds_daily_cap' };
  if (i.amount > i.mandate.approvalThreshold) return { decision: 'approval_required', reason: 'above_approval_threshold' };
  return { decision: 'allow' };
}
