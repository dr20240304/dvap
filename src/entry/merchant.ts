import { DEFAULT_PORTS, envPort, loadKeys } from '../common/config';
import { listen } from '../common/service';
import { createMerchantApp } from '../merchant';

const keys = loadKeys();
await listen('merchant-api', createMerchantApp({ facilitatorUrl: process.env.FACILITATOR_URL!, ledgerUrl: process.env.LEDGER_URL, serviceKey: keys.serviceKey }), envPort('PORT', DEFAULT_PORTS.merchant));
