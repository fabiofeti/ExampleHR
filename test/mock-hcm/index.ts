import { Server, Socket } from 'net';
import { createMockHcmApp } from './server';
import { reset } from './state';

let server: Server | null = null;
const openSockets = new Set<Socket>();

export function startMockHcm(
  examplehrBaseUrl: string,
  port = 4001,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const app = createMockHcmApp(examplehrBaseUrl);
    server = app.listen(port, () => resolve());
    server.once('error', reject);
    server.on('connection', (sock: Socket) => {
      openSockets.add(sock);
      sock.once('close', () => openSockets.delete(sock));
    });
  });
}

export function stopMockHcm(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) return resolve();
    const s = server;
    server = null;
    // Destroy open keep-alive sockets so server.close() callback fires promptly.
    for (const sock of openSockets) sock.destroy();
    openSockets.clear();
    s.close(err => (err ? reject(err) : resolve()));
  });
}

export function resetMockHcm(): void {
  reset();
}

export { setBalance, setMode, getCallLog } from './state';
export type { MockBalance, MockMode, CallLogEntry } from './state';
