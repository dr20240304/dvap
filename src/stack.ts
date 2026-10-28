import path from 'node:path';
import { DEFAULT_PORTS, dataDir, envPort, type Keys } from './common/config';
import { listen, type RunningService } from './common/service';
import { createApprovalUiApp } from './approval-ui';
import { createDashboardApp } from './dashboard';
import { createFacilitatorApp } from './facilitator';
import { createIntakeApp } from './intake';
import { openDb } from './ledger/db';
import { createLedgerApp } from './ledger/server';
import { ensureDataDir } from './ledger/seed';
import { LedgerService } from './ledger/service';
import { createMerchantApp } from './merchant';
import { createPaymentsMcpApp } from './payments-mcp';
import { createVendorMcpApp } from './vendor-mcp';

export interface Stack {
  keys: Keys;
  ledger: LedgerService;
  urls: { ledger: string; facilitator: string; merchant: string; mcp: string; approval: string; vendorMcp: string; intake: string; dashboard: string };
  close(): Promise<void>;
}

/** Boot every PayPilot service in one process. `ephemeral` uses random free ports (tests). */
export async function startStack(opts: { dir?: string; ephemeral?: boolean; reset?: boolean } = {}): Promise<Stack> {
  const dir = opts.dir ?? dataDir();
  const { keys, dbFile } = ensureDataDir(dir, opts.reset ?? false);
  const p = (name: keyof typeof DEFAULT_PORTS) => (opts.ephemeral ? 0 : envPort(`${name.toUpperCase()}_PORT`, DEFAULT_PORTS[name]));

  const db = openDb(dbFile);
  const ledgerSvc = new LedgerService(db);
  const running: RunningService[] = [];

  const ledger = await listen('ledger', createLedgerApp(ledgerSvc, keys.serviceKey), p('ledger'));
  running.push(ledger);
  const facilitator = await listen('facilitator', createFacilitatorApp({ ledgerUrl: ledger.url, serviceKey: keys.serviceKey }), p('facilitator'));
  running.push(facilitator);
  const merchant = await listen('merchant-api', createMerchantApp({ facilitatorUrl: facilitator.url, ledgerUrl: ledger.url, serviceKey: keys.serviceKey }), p('merchant'));
  running.push(merchant);
  const mcp = await listen('payments-mcp', createPaymentsMcpApp({ ledgerUrl: ledger.url, serviceKey: keys.serviceKey, dataDir: dir }), p('mcp'));
  running.push(mcp);
  const approval = await listen(
    'approval-ui',
    createApprovalUiApp({ ledgerUrl: ledger.url, serviceKey: keys.serviceKey, cfoPrivateKey: keys.cfoPrivateKey }),
    p('approval'),
  );
  running.push(approval);

  const vendor = await listen('vendor-mcp', createVendorMcpApp(undefined, { facilitatorUrl: facilitator.url }), p('vendor'));
  running.push(vendor);

  const intake = await listen('invoice-intake', createIntakeApp({ ledgerUrl: ledger.url, serviceKey: keys.serviceKey }), p('intake'));
  running.push(intake);

  const dashboard = await listen('dashboard', createDashboardApp({ ledgerUrl: ledger.url, serviceKey: keys.serviceKey }), p('dashboard'));
  running.push(dashboard);

  return {
    keys,
    ledger: ledgerSvc,
    urls: { ledger: ledger.url, facilitator: facilitator.url, merchant: merchant.url, mcp: `${mcp.url}/mcp`, approval: approval.url, vendorMcp: `${vendor.url}/mcp`, intake: intake.url, dashboard: dashboard.url },
    async close() {
      await Promise.all(running.map((s) => s.close()));
      db.close();
    },
  };
}

// `npm run dev`: run the whole stack on the fixed ports.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  startStack().then((s) => {
    console.log('\nPayPilot is up.');
    console.log(`  Approval UI : ${s.urls.approval}`);
    console.log(`  Dashboard   : ${s.urls.dashboard}   (read-only ledger view)`);
    console.log(`  MCP endpoint: ${s.urls.mcp}`);
    console.log(`  Invoice inbox: POST ${s.urls.intake}/invoices/pdf  (application/pdf)`);
    console.log('  Try: npm run agent -- "Pay the Initech invoice"   (then approve in the UI)\n');
    const stop = () => void s.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
