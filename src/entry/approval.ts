import { createApprovalUiApp } from '../approval-ui';
import { DEFAULT_PORTS, envPort, loadKeys } from '../common/config';
import { listen } from '../common/service';

const keys = loadKeys();
await listen('approval-ui', createApprovalUiApp({ ledgerUrl: process.env.LEDGER_URL!, serviceKey: keys.serviceKey, cfoToken: keys.cfoToken }), envPort('PORT', DEFAULT_PORTS.approval));
