/**
 * Sign a message with an ed25519 private key (PKCS8, base64) and print the base64 signature.
 *   npx tsx scripts/sign-tx.ts <privateKeyB64> <message>
 * The Python exploit tooling has no ed25519 in its standard library, so (like scripts/pay.ts) it shells out to this.
 */
import { signMessage } from '../src/common/crypto';

const [key, message] = process.argv.slice(2);
if (!key || message === undefined) {
  console.error('usage: sign-tx.ts <privateKeyB64> <message>');
  process.exit(2);
}
process.stdout.write(signMessage(key, message));
