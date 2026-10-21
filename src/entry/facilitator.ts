import { DEFAULT_PORTS, envPort, loadKeys } from '../common/config';
import { listen } from '../common/service';
import { createFacilitatorApp } from '../facilitator';

const keys = loadKeys();
await listen('facilitator', createFacilitatorApp({ ledgerUrl: process.env.LEDGER_URL!, serviceKey: keys.serviceKey }), envPort('PORT', DEFAULT_PORTS.facilitator));
