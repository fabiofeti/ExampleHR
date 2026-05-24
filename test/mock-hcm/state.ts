export type MockMode = 'normal' | 'reject-next' | 'timeout-next' | 'error-next' | 'error-always' | 'accept-all';

export interface MockBalance {
  employeeId: string;
  locationId: string;
  available: number;
  used: number;
  total: number;
}

export interface CallLogEntry {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[]>;
  timestamp: string;
}

function balanceKey(employeeId: string, locationId: string): string {
  return `${employeeId}::${locationId}`;
}

const balances = new Map<string, MockBalance>();
let mode: MockMode = 'normal';
const callLog: CallLogEntry[] = [];

export function getBalance(employeeId: string, locationId: string): MockBalance | undefined {
  return balances.get(balanceKey(employeeId, locationId));
}

export function setBalance(b: MockBalance): void {
  balances.set(balanceKey(b.employeeId, b.locationId), { ...b });
}

export function deductBalance(
  employeeId: string,
  locationId: string,
  days: number,
): MockBalance | null {
  const b = balances.get(balanceKey(employeeId, locationId));
  if (!b) return null;
  b.available -= days;
  b.used += days;
  return { ...b };
}

export function restoreBalance(
  employeeId: string,
  locationId: string,
  days: number,
): MockBalance | null {
  const b = balances.get(balanceKey(employeeId, locationId));
  if (!b) return null;
  b.available += days;
  b.used -= days;
  return { ...b };
}

export function getMode(): MockMode {
  return mode;
}

export function setMode(m: MockMode): void {
  mode = m;
}

export function resetMode(): void {
  mode = 'normal';
}

export function getCallLog(): CallLogEntry[] {
  return [...callLog];
}

export function appendCallLog(entry: CallLogEntry): void {
  callLog.push(entry);
}

export function reset(): void {
  balances.clear();
  mode = 'normal';
  callLog.length = 0;
}
