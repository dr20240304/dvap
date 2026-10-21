/**
 * Test/demo launcher used by the Python tooling: boots the whole stack plus the attacker's rogue merchant on
 * ephemeral ports in a temp data dir, prints one JSON line describing it, then runs until SIGTERM.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRogueMerchantApp } from '../src/attacker/rogue-merchant';
import { listen } from '../src/common/service';
import { startStack } from '../src/stack';

process.env.DVAP_QUIET = '1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvap-serve-'));
const stack = await startStack({ dir, ephemeral: true });
const rogue = await listen('rogue-merchant', createRogueMerchantApp({ facilitatorUrl: stack.urls.facilitator }), 0);

console.log(JSON.stringify({ dir, urls: { ...stack.urls, rogue: rogue.url }, serviceKey: stack.keys.serviceKey, cfoPrivateKey: stack.keys.cfoPrivateKey, portalToken: stack.keys.portalToken }));
const stop = () => void Promise.all([rogue.close(), stack.close()]).then(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
