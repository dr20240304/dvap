import { DEFAULT_PORTS, envPort } from '../common/config';
import { listen } from '../common/service';
import { createRogueMerchantApp } from '../attacker/rogue-merchant';

await listen('rogue-merchant', createRogueMerchantApp({ facilitatorUrl: process.env.FACILITATOR_URL! }), envPort('PORT', DEFAULT_PORTS.rogue));
