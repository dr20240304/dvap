/**
 * x402 buyer CLI for the Python tooling (stdlib Python cannot sign ed25519).
 *   tsx scripts/pay.ts header <url>            fetch the 402, print a signed PAYMENT-SIGNATURE header (nothing is sent)
 *   tsx scripts/pay.ts headers <url> <n>       same, n headers with distinct nonces
 *   tsx scripts/pay.ts buy <url> [times]       pay and fetch `times` times (sequential), print each result
 * Reads the agent key from $DVAP_DATA_DIR/keys.json. Honours DVAP_HARDEN like the real agent does.
 * Output: one JSON document on stdout.
 */
import { buildPaymentHeader, fetchPaid, parseMaxPrice } from '../src/agent/x402-client';
import { MERCHANT_ACCOUNT, loadKeys } from '../src/common/config';
import { parseB64json } from '../src/common/crypto';
import { HEADER_REQUIRED, type PaymentRequired } from '../src/common/x402';

const [mode, url, times = '1'] = process.argv.slice(2);
if (!mode || !url) {
  console.error('usage: pay.ts header <url> | buy <url> [times]');
  process.exit(2);
}
const keys = loadKeys();
const signer = { agentId: keys.agentId, privateKey: keys.agentPrivateKey };

if (mode === 'header' || mode === 'headers') {
  const r = await fetch(url);
  const raw = r.headers.get(HEADER_REQUIRED);
  if (r.status !== 402 || !raw) {
    console.log(JSON.stringify({ error: `expected a 402, got HTTP ${r.status}` }));
    process.exit(1);
  }
  const pr = parseB64json<PaymentRequired>(raw);
  const shift = Number(process.env.PAY_CLOCK_SHIFT ?? 0); // seconds; lets a test sign a payment valid far into the future (V21)
  const make = () => buildPaymentHeader(url, pr, pr.accepts[0]!, signer, () => Math.floor(Date.now() / 1000) + shift);
  console.log(JSON.stringify(mode === 'header' ? { header: make() } : { headers: Array.from({ length: Number(times) }, make) }));
} else if (mode === 'buy') {
  const policy = { allowedPayTo: [MERCHANT_ACCOUNT], maxAmountMicros: parseMaxPrice(process.env.MAX_PRICE_MICROS, 5_000_000) };
  const out = [];
  for (let i = 0; i < Number(times); i++) {
    try {
      const r = await fetchPaid(url, signer, policy);
      out.push({ status: r.status, paid: r.paid ?? null });
    } catch (e) {
      out.push({ error: e instanceof Error ? e.message : String(e) });
    }
  }
  console.log(JSON.stringify({ results: out }));
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
