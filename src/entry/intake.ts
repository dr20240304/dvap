import { DEFAULT_PORTS, envPort, loadKeys } from '../common/config';
import { listen } from '../common/service';
import { createIntakeApp } from '../intake';

const keys = loadKeys();
await listen('invoice-intake', createIntakeApp({ ledgerUrl: process.env.LEDGER_URL!, serviceKey: keys.serviceKey }), envPort('PORT', DEFAULT_PORTS.intake));
