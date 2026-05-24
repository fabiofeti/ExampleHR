import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import { IHcmAdapter, HcmBalanceResponse } from '../ports/hcm-adapter.port';
import {
  HcmRejectionException,
  HcmUnavailableException,
  InsufficientBalanceException,
} from '../../common/exceptions';

@Injectable()
export class HcmAdapterService implements IHcmAdapter {
  private readonly logger = new Logger(HcmAdapterService.name);
  private readonly client: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.client = axios.create({
      baseURL: config.get<string>('HCM_BASE_URL'),
      timeout: config.get<number>('HCM_TIMEOUT_MS', 5000),
    });
  }

  async deduct(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmBalanceResponse> {
    try {
      const { data } = await this.client.post<HcmBalanceResponse>(
        '/hcm/deduct',
        { employeeId, locationId, days },
        { headers: { 'X-Idempotency-Key': `${idempotencyKey}-approve` } },
      );
      return data;
    } catch (err) {
      this.logger.warn('HCM deduct failed', {
        employeeId,
        locationId,
        operation: 'deduct',
        error: err instanceof Error ? err.message : String(err),
      });
      return this.mapDeductError(err, days, idempotencyKey);
    }
  }

  async restore(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmBalanceResponse> {
    try {
      const { data } = await this.client.post<HcmBalanceResponse>(
        '/hcm/restore',
        { employeeId, locationId, days },
        { headers: { 'X-Idempotency-Key': `${idempotencyKey}-cancel` } },
      );
      return data;
    } catch (err) {
      this.logger.warn('HCM restore failed', {
        employeeId,
        locationId,
        operation: 'restore',
        error: err instanceof Error ? err.message : String(err),
      });
      throw new HcmUnavailableException(idempotencyKey);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.get('/health');
      return true;
    } catch {
      return false;
    }
  }

  private mapDeductError(err: unknown, days: number, traceId: string): never {
    if (isAxiosError(err) && err.response) {
      const { status, data } = err.response;
      if (status >= 400 && status < 500) {
        const body = data as Record<string, unknown>;
        if (body['code'] === 'INSUFFICIENT_BALANCE') {
          // HCM is authoritative — balance too low even though local check passed
          throw new InsufficientBalanceException(0, days);
        }
        const message = body['message'];
        throw new HcmRejectionException(
          typeof message === 'string' ? message : 'HCM rejected the operation',
        );
      }
    }
    throw new HcmUnavailableException(traceId);
  }
}
