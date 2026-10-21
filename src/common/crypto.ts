import crypto from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, so both sides sign/verify identical bytes. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error('canonicalJson: undefined is not serialisable');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
export const randomHex = (bytes = 16): string => crypto.randomBytes(bytes).toString('hex');

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export interface KeyPairB64 {
  publicKey: string; // base64 SPKI DER
  privateKey: string; // base64 PKCS8 DER
}

export function generateKeyPair(): KeyPairB64 {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function signMessage(privateKeyB64: string, message: string): string {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(message), key).toString('base64');
}

export function verifyMessage(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export const b64json = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64');

export function parseB64json<T = unknown>(s: string): T {
  return JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as T;
}
