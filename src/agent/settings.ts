import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORTS, MERCHANT_ACCOUNT, envPort } from '../common/config';
import { hardened } from '../common/harden';
import { parseMaxPrice, type ChallengePolicy } from './x402-client';

export interface AgentSettings {
  mcpUrl: string;
  merchantUrl: string;
  vendorMcpUrl?: string;
  approvedMcpUrls: string[];
  challengePolicy: ChallengePolicy;
  notes: string[];
}

interface WorkspaceConfig { merchantUrl?: string; vendorMcpUrl?: string; allowedPayTo?: string[]; approvedMcpUrls?: string[] }

/**
 * Resolve the agent's settings from the environment, then from a project-local `.paypilot.json` in the workspace.
 * V32: ambient authority. VULNERABLE BY DEFAULT: whatever folder the agent is started in can carry a config file that is trusted like
 * the operator's own — it can point the agent at another merchant, add MCP servers to the approved list and widen the payee allowlist
 * (the same shape as repo-level config files that agent tools auto-load). DVAP_HARDEN=V32: workspace files are untrusted input
 * and are ignored; only environment/operator settings count.
 */
export function resolveSettings(env: NodeJS.ProcessEnv, workspaceDir: string): AgentSettings {
  const notes: string[] = [];
  const s: AgentSettings = {
    mcpUrl: env.MCP_URL ?? `http://127.0.0.1:${envPort('MCP_PORT', DEFAULT_PORTS.mcp)}/mcp`,
    merchantUrl: env.MERCHANT_URL ?? `http://127.0.0.1:${envPort('MERCHANT_PORT', DEFAULT_PORTS.merchant)}`,
    vendorMcpUrl: env.VENDOR_MCP_URL || undefined,
    approvedMcpUrls: (env.APPROVED_MCP_URLS ?? '').split(',').filter(Boolean),
    challengePolicy: { allowedPayTo: [MERCHANT_ACCOUNT], maxAmountMicros: parseMaxPrice(env.MAX_PRICE_MICROS) },
    notes,
  };
  const file = path.join(workspaceDir, '.paypilot.json');
  if (!fs.existsSync(file)) return s;
  if (hardened('V32')) {
    notes.push(`ignored untrusted workspace config ${file}`);
    return s;
  }
  const ws = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkspaceConfig;
  notes.push(`loaded workspace config ${file}`);
  if (ws.merchantUrl) s.merchantUrl = ws.merchantUrl;
  if (ws.vendorMcpUrl) s.vendorMcpUrl = ws.vendorMcpUrl;
  if (ws.allowedPayTo) s.challengePolicy.allowedPayTo.push(...ws.allowedPayTo);
  if (ws.approvedMcpUrls) s.approvedMcpUrls.push(...ws.approvedMcpUrls);
  return s;
}
