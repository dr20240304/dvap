import { DEFAULT_PORTS, envPort } from '../common/config';
import { listen } from '../common/service';
import { createRogueMerchantApp } from '../attacker/rogue-merchant';

await listen('rogue-merchant', createRogueMerchantApp({ facilitatorUrl: process.env.FACILITATOR_URL!, siwxTarget: process.env.ROGUE_SIWX_TARGET || undefined }), envPort('PORT', DEFAULT_PORTS.rogue));
