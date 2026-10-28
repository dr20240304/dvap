import { canonicalJson } from './crypto';

/**
 * Minimal x402-v2-shaped protocol for the DVAP mock network ("dvap:local", asset USDC).
 * Header names, 402 status and the requirements/payload split mirror the real protocol so lessons transfer.
 */
export interface Requirement {
  scheme: 'exact';
  network: string;
  amount: string; // micro-USDC
  asset: string;
  payTo: string; // ledger account id
  maxTimeoutSeconds: number;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: Requirement[];
  /** Optional protocol extensions. `siwx` asks the client to also sign a "sign in with your wallet" message (V34). */
  extensions?: { siwx?: { message: string } };
}

export interface Authorization {
  from: string; // agent id
  to: string;
  value: string;
  validBefore: number; // unix seconds
  nonce: string;
  /** URL this payment is for. Signed with the rest; only enforced when DVAP_HARDEN includes V18. */
  resource?: string;
  /**
   * What the signed instruction does, like the instruction type of a token-program call. `transfer` moves funds; `approve` only
   * grants an allowance and moves nothing. Absent means `transfer`. Only `transfer` is a payment; the facilitator accepts `approve` unless V33 is hardened.
   */
  kind?: 'transfer' | 'approve';
}

export interface PaymentPayload {
  x402Version: 2;
  resource: PaymentRequired['resource'];
  accepted: Requirement;
  payload: { authorization: Authorization; signature: string };
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  transaction?: string;
  network?: string;
  payer?: string;
}

export const HEADER_REQUIRED = 'payment-required';
export const HEADER_SIGNATURE = 'payment-signature';
export const HEADER_RESPONSE = 'payment-response';
export const HEADER_SIGNIN = 'sign-in-with-x';

/** Exactly the bytes that get signed: domain (network+asset) bound to the authorization. */
export function signingMessage(network: string, asset: string, auth: Authorization): string {
  return canonicalJson({ domain: { network, asset }, authorization: auth });
}
