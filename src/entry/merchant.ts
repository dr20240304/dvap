import { DEFAULT_PORTS, envPort } from '../common/config';
import { listen } from '../common/service';
import { createMerchantApp } from '../merchant';

await listen('merchant-api', createMerchantApp({ facilitatorUrl: process.env.FACILITATOR_URL! }), envPort('PORT', DEFAULT_PORTS.merchant));
