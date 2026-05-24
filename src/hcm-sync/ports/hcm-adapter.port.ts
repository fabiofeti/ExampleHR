export interface HcmBalanceResponse {
  employeeId: string;
  locationId: string;
  available: number;
  used: number;
  total: number;
}

export interface IHcmAdapter {
  deduct(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmBalanceResponse>;

  restore(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmBalanceResponse>;

  ping(): Promise<boolean>;
}

export const HCM_ADAPTER_TOKEN = 'HCM_ADAPTER_TOKEN';
