import { describe, expect, it } from 'vitest';
import { canonicalJson, generateKeyPair, signMessage, verifyMessage } from '../src/common/crypto';
import { parseMicros, usd, dollars } from '../src/common/money';
import { hardened } from '../src/common/harden';
import { evaluatePolicy, type Mandate } from '../src/ledger/policy';

describe('crypto', () => {
  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  });
  it('sign/verify round-trips and rejects tampering and wrong keys', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const sig = signMessage(a.privateKey, 'hello');
    expect(verifyMessage(a.publicKey, 'hello', sig)).toBe(true);
    expect(verifyMessage(a.publicKey, 'hellO', sig)).toBe(false);
    expect(verifyMessage(b.publicKey, 'hello', sig)).toBe(false);
    expect(verifyMessage(a.publicKey, 'hello', 'not-base64!!')).toBe(false);
  });
});

describe('money', () => {
  it('accepts positive integer strings only', () => {
    expect(parseMicros('250000')).toBe(250000);
    for (const bad of ['0', '-5', '1.5', '1e6', '007', '', ' 5', '99999999999999999999', 'abc', null, undefined, {}]) {
      expect(() => parseMicros(bad as unknown)).toThrow();
    }
    expect(() => parseMicros(1.5)).toThrow();
  });
  it('formats USD', () => {
    expect(usd(250000)).toBe('$0.25');
    expect(usd(dollars(1200))).toBe('$1,200.00');
  });
});

describe('hardened()', () => {
  it('reads DVAP_HARDEN at call time', () => {
    delete process.env.DVAP_HARDEN;
    expect(hardened('V7')).toBe(false);
    process.env.DVAP_HARDEN = 'v7, V15';
    expect(hardened('V7')).toBe(true);
    expect(hardened('V15')).toBe(true);
    expect(hardened('V8')).toBe(false);
    process.env.DVAP_HARDEN = 'all';
    expect(hardened('V8')).toBe(true);
    delete process.env.DVAP_HARDEN;
  });
});

describe('policy', () => {
  const mandate: Mandate = { perTxCap: 5000, dailyCap: 10000, approvalThreshold: 500, allowedPayees: ['p1'] };
  const base = { amount: 100, payeeId: 'p1', payeeVerified: true, spentToday: 0, mandate };
  it('allows small payments to allowlisted verified payees', () => expect(evaluatePolicy(base)).toEqual({ decision: 'allow' }));
  it('requires approval above threshold', () => expect(evaluatePolicy({ ...base, amount: 501 }).decision).toBe('approval_required'));
  it('boundary: exactly the threshold is allowed', () => expect(evaluatePolicy({ ...base, amount: 500 }).decision).toBe('allow'));
  it('denies unknown payee, unverified payee, over per-tx cap, over daily cap', () => {
    expect(evaluatePolicy({ ...base, payeeId: 'x' })).toMatchObject({ decision: 'deny', reason: 'payee_not_in_mandate_allowlist' });
    expect(evaluatePolicy({ ...base, payeeVerified: false })).toMatchObject({ decision: 'deny', reason: 'payee_not_verified' });
    expect(evaluatePolicy({ ...base, amount: 5001 })).toMatchObject({ decision: 'deny', reason: 'exceeds_per_transaction_cap' });
    expect(evaluatePolicy({ ...base, amount: 600, spentToday: 9500 })).toMatchObject({ decision: 'deny', reason: 'exceeds_daily_cap' });
  });
});
