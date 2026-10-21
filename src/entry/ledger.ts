import { envPort, DEFAULT_PORTS, dataDir } from '../common/config';
import { listen } from '../common/service';
import { openDb } from '../ledger/db';
import { ensureDataDir } from '../ledger/seed';
import { createLedgerApp } from '../ledger/server';
import { LedgerService } from '../ledger/service';

const { keys, dbFile } = ensureDataDir(dataDir()); // idempotent: seeds only an empty database
await listen('ledger', createLedgerApp(new LedgerService(openDb(dbFile)), keys.serviceKey), envPort('PORT', DEFAULT_PORTS.ledger));
