/**
 * Minimal "Sign-In-With-X" (SIWx) for the DVAP mock network: a wallet proves it controls an address by signing a message that
 * names the site it is logging in to. Shaped like EIP-4361 (SIWE) so the lesson transfers: the signature is only worth anything
 * if the signer checks that the `domain` line is the site it is actually talking to.
 */
export interface SiwxFields {
  domain: string; // host (with port) of the site being logged in to
  address: string; // the wallet / agent id that signs
  nonce: string;
  issuedAt: string; // ISO time
}

export interface SiwxPayload {
  message: string;
  signature: string;
  address: string;
}

export function siwxMessage(f: SiwxFields): string {
  return `${f.domain} wants you to sign in with your DVAP wallet:\n${f.address}\n\nNonce: ${f.nonce}\nIssued At: ${f.issuedAt}`;
}

export function parseSiwxMessage(message: string): SiwxFields | null {
  const m = /^(\S+) wants you to sign in with your DVAP wallet:\n(\S+)\n\nNonce: (\S+)\nIssued At: (\S+)$/.exec(message);
  return m ? { domain: m[1]!, address: m[2]!, nonce: m[3]!, issuedAt: m[4]! } : null;
}
