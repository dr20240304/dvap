import { DEFAULT_PORTS, envPort, loadKeys } from '../common/config';
import { listen } from '../common/service';
import { createPaymentsMcpApp } from '../payments-mcp';

const keys = loadKeys();
await listen('payments-mcp', createPaymentsMcpApp({ ledgerUrl: process.env.LEDGER_URL!, serviceKey: keys.serviceKey }), envPort('PORT', DEFAULT_PORTS.mcp));
