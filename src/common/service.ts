import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BANNER } from './config';

export interface RunningService {
  name: string;
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Listen on localhost by default (HOST=0.0.0.0 only inside containers). Port 0 = ephemeral (tests). */
export function listen(name: string, app: Express, port: number, host = process.env.HOST ?? '127.0.0.1'): Promise<RunningService> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      const svc: RunningService = {
        name,
        server,
        port: addr.port,
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      };
      if (process.env.DVAP_QUIET !== '1') console.log(`[${name}] listening on ${svc.url}  ${BANNER}`);
      resolve(svc);
    });
    server.on('error', reject);
  });
}
