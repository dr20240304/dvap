import { DEFAULT_PORTS, envPort } from '../common/config';
import { listen } from '../common/service';
import { createVendorMcpApp } from '../vendor-mcp';

await listen('vendor-mcp', createVendorMcpApp(), envPort('PORT', DEFAULT_PORTS.vendor));
