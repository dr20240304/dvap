import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PORTS = { ledger: 4000, facilitator: 4022, merchant: 4021, mcp: 4100, approval: 4200, rogue: 4666, vendor: 4300, intake: 4400, dashboard: 4500 } as const;

export const NETWORK = 'dvap:local';
export const ASSET = 'USDC';
export const OPERATING_ACCOUNT = 'acct_acme_operating';
export const AGENT_WALLET_ACCOUNT = 'acct_agent_wallet';
export const MERCHANT_ACCOUNT = 'acct_vettingco';
/** Attacker-controlled receiving account (Globex's drop). Lives in the same ledger so the loss is visible. */
/** Facilitator gas sponsorship (V25): the sponsor fronts the network fee for each settlement attempt. */
export const SPONSOR_ACCOUNT = 'acct_facilitator_gas';
export const FEE_ACCOUNT = 'acct_network_fees';
export const GAS_FEE = 10_000; // $0.01
/** Largest payment an "emergency override" may push through without human approval (V26). */
export const OVERRIDE_CEILING = 1_000_000_000; // $1,000
export const PORTAL_AGENT_ID = 'agent-portal';
export const ATTACKER_ACCOUNT = 'acct_globex_drop';

/** The agent's x402 wallet budget per UTC day (micro-USDC). The system prompt promises it; the ledger enforces it only with V6 hardened. */
export const X402_DAILY_CAP = 5_000_000;

export const dataDir = (): string => process.env.DVAP_DATA_DIR ?? path.resolve(process.cwd(), '.dvap-data');

export interface Keys {
  /** shared secret between internal services and the ledger */
  serviceKey: string;
  agentId: string;
  agentPrivateKey: string;
  agentPublicKey: string;
  /** bearer token the agent presents to payments-mcp */
  agentToken: string;
  /** low-privilege credential issued to suppliers for their invoice-status portal assistant */
  portalToken: string;
  /** the CFO's signing key (ed25519, PKCS8 base64): held by the CFO signing UI only. The ledger knows only the public half */
  cfoPrivateKey: string;
  cfoPublicKey: string;
}

export function loadKeys(dir: string = dataDir()): Keys {
  const file = path.join(dir, 'keys.json');
  if (!fs.existsSync(file)) throw new Error(`keys not found at ${file} — run "npm run seed" first`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Keys;
}

export const BANNER = '⚠️  DVAP — INTENTIONALLY VULNERABLE demo system. Fictional money only. Never deploy or expose.';

export const envPort = (name: string, fallback: number): number => {
  const v = process.env[name];
  return v ? Number(v) : fallback;
};
