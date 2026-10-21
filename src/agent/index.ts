import { BANNER, loadKeys } from '../common/config';
import { runLlmAgent } from './llm';
import { runAgent } from './runner';
import { resolveSettings } from './settings';

/** CLI: npm run agent -- "Pay the Initech invoice" */
async function main() {
  const prompt = process.argv.slice(2).join(' ').trim() || 'Pay the Initech invoice';
  const keys = loadKeys();
  console.log(BANNER);
  console.log(`\n> ${prompt}\n`);
  const settings = resolveSettings(process.env, process.env.PAYPILOT_WORKSPACE ?? process.cwd());
  for (const n of settings.notes) console.log(`ℹ️  ${n}`);
  const run = process.env.AGENT_MODE === 'llm' ? runLlmAgent : runAgent;
  if (run === runLlmAgent) console.log(`(LLM mode: ${process.env.OLLAMA_MODEL ?? 'llama3.1:8b-instruct-q4_K_M'} via Ollama — outcomes depend on the model)`);
  const result = await run(prompt, {
    mcpUrl: settings.mcpUrl,
    merchantUrl: settings.merchantUrl,
    agentToken: keys.agentToken,
    vendorMcpUrl: settings.vendorMcpUrl,
    approvedMcpUrls: settings.approvedMcpUrls,
    challengePolicy: settings.challengePolicy,
    enrichVendors: process.env.ENRICH_VENDOR === '1',
    vetVendors: process.env.AGENT_VET !== 'off',
    signer: { agentId: keys.agentId, privateKey: keys.agentPrivateKey },
    approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 120_000),
    log: (l) => console.log(l),
  });
  console.log(`\nResult: ${result.outcome} — ${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('agent error:', e instanceof Error ? e.message : e);
  process.exit(2);
});
