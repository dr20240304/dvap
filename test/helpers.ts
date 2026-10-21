import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, type Stack } from '../src/stack';
import { LedgerClient } from '../src/common/ledgerClient';
import type { AgentConfig } from '../src/agent/runner';

process.env.DVAP_QUIET = '1';

export interface TestStack extends Stack {
  dir: string;
  client: LedgerClient;
  agentConfig(over?: Partial<AgentConfig>): AgentConfig;
  teardown(): Promise<void>;
}

export async function withStack(): Promise<TestStack> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvap-test-'));
  const stack = await startStack({ dir, ephemeral: true });
  const client = new LedgerClient(stack.urls.ledger, stack.keys.serviceKey);
  return {
    ...stack,
    dir,
    client,
    agentConfig: (over = {}) => ({
      mcpUrl: stack.urls.mcp,
      merchantUrl: stack.urls.merchant,
      agentToken: stack.keys.agentToken,
      signer: { agentId: stack.keys.agentId, privateKey: stack.keys.agentPrivateKey },
      approvalTimeoutMs: 15_000,
      pollMs: 30,
      ...over,
    }),
    async teardown() {
      await stack.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const bal = async (t: TestStack, id: string) => Number((await t.client.getAccount(id)).balance);

/** The CFO clicking Approve/Reject in the approval page: same-origin, with the session cookie and token the page fetches first. */
export async function cfoClick(approvalUrl: string, id: string, verb: 'approve' | 'reject' = 'approve'): Promise<Response> {
  const s = await fetch(`${approvalUrl}/api/session`);
  const cookie = (s.headers.get('set-cookie') ?? '').split(';')[0]!;
  const { csrf } = await s.json();
  return fetch(`${approvalUrl}/api/payments/${id}/${verb}`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
}
