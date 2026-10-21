import { DEFAULT_PORTS, envPort, loadKeys } from '../common/config';
import { listen } from '../common/service';
import { createDashboardApp } from '../dashboard';

const keys = loadKeys();
await listen('dashboard', createDashboardApp({ ledgerUrl: process.env.LEDGER_URL!, serviceKey: keys.serviceKey }), envPort('PORT', DEFAULT_PORTS.dashboard));
