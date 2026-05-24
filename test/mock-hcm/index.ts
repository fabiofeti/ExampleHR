import { Server } from 'http';
import { createMockHcmApp } from './server';
import { reset } from './state';

let server: Server | null = null;

export function startMockHcm(
  examplehrBaseUrl: string,
  port = 4001,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const app = createMockHcmApp(examplehrBaseUrl);
    server = app.listen(port, () => resolve());
    server.once('error', reject);
  });
}

export function stopMockHcm(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) return resolve();
    server.close(err => (err ? reject(err) : resolve()));
    server = null;
  });
}

export function resetMockHcm(): void {
  reset();
}

export { setBalance, setMode, getCallLog } from './state';
export type { MockBalance, MockMode, CallLogEntry } from './state';
