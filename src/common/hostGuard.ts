import type { NextFunction, Request, Response } from 'express';
import { hardened } from './harden';

const DEFAULT_HOSTS = ['localhost', '127.0.0.1', '[::1]', 'mcp', 'approval', 'approval-ui', 'payments-mcp'];

/**
 * V27: Host-header trust (DNS rebinding). These services are reachable on localhost and accept any Host header, so a web page
 * the operator visits can rebind its own domain to 127.0.0.1 and talk to them with the operator's network position.
 * VULNERABLE BY DEFAULT: nothing checks Host. DVAP_HARDEN=V27: only known host names are served (421 otherwise).
 * Extra names: ALLOWED_HOSTS=a,b
 */
export function hostGuard(req: Request, res: Response, next: NextFunction): void {
  if (!hardened('V27')) return next();
  const host = (req.header('host') ?? '').replace(/:\d+$/, '').toLowerCase();
  const allowed = [...DEFAULT_HOSTS, ...(process.env.ALLOWED_HOSTS ?? '').split(',').filter(Boolean)];
  if (!allowed.includes(host)) {
    res.status(421).json({ error: 'bad_host', message: `host ${host || '(none)'} is not served here` });
    return;
  }
  next();
}
