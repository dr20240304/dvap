import { dataDir } from '../src/common/config';
import { ensureDataDir } from '../src/ledger/seed';

const reset = process.argv.includes('--reset');
const dir = dataDir();
const { dbFile } = ensureDataDir(dir, reset);
console.log(`${reset ? 'Reset and seeded' : 'Seeded (if empty)'} Acme world → ${dbFile}`);
console.log('Invoices: INV-1001 Initech $1,200 (needs CFO approval) · INV-1002 Hooli $300 (auto) · INV-2001 Globex $9,500 (unverified vendor)');
