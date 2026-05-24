import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import CircuitBreaker from 'opossum';
import { IHcmAdapter, HcmBalanceResponse } from '../ports/hcm-adapter.port';
import {
  HcmRejectionException,
  HcmUnavailableException,
  InsufficientBalanceException,
} from '../../common/exceptions';
import { SyncLogService } from '../../sync-log/sync-log.service';
import { SyncSource } from '../../sync-log/sync-log.entity';

@Injectable()
export class HcmAdapterService implements IHcmAdapter {
  private readonly logger = new Logger(HcmAdapterService.name);
  private readonly client: AxiosInstance;
  private readonly deductBreaker: CircuitBreaker;
  private readonly restoreBreaker: CircuitBreaker;
  private readonly pingBreaker: CircuitBreaker;

  constructor(
    private readonly config: ConfigService,
    private readonly syncLogService: SyncLogService,
  ) {
    this.client = axios.create({
      baseURL: config.get<string>('HCM_BASE_URL'),
      timeout: config.get<number>('HCM_TIMEOUT_MS', 5000),
    });

    const breakerOptions: CircuitBreaker.Options = {
      errorThresholdPercentage:
        (config.get<number>('CIRCUIT_BREAKER_THRESHOLD', 0.5) as number) * 100,
      volumeThreshold: config.get<number>('CIRCUIT_BREAKER_VOLUME', 10) as number,
      resetTimeout: config.get<number>(
        'CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
        30000,
      ) as number,
      timeout: false,
    };

    this.deductBreaker = new CircuitBreaker(
      this.executeDeduct.bind(this),
      breakerOptions,
    );
    this.restoreBreaker = new CircuitBreaker(
      this.executeRestore.bind(this),
      breakerOptions,
    );
    this.pingBreaker = new CircuitBreaker(
      this.executePing.bind(this),
      breakerOptions,
    );

    this.deductBreaker.fallback((...args: unknown[]) => {
      const err = args[args.length - 1];
      if (err instanceof Error && CircuitBreaker.isOurError(err)) {
        throw new HcmUnavailableException('circuit-open');
      }
      throw err;
    });
    this.restoreBreaker.fallback((...args: unknown[]) => {
      const err = args[args.length - 1];
      if (err instanceof Error && CircuitBreaker.isOurError(err)) {
        throw new HcmUnavailableException('circuit-open');
      }
      throw err;
    });
    this.pingBreaker.fallback(() => false);
  }

  async deduct(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmBalanceResponse> {
    return this.deductBreaker.fire(
      employeeId,
      locationId,
      days,
      idempotencyKey,
    ) as Promise<HcmBalanceResponse>;
  }

  async restore(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmBalanceResponse> {
    return this.restoreBreaker.fire(
      employeeId,
      locationId,
      days,
      idempotencyKey,
    ) as Promise<HcmBalanceResponse>;
  }

  async ping(): Promise<boolean> {
    return this.pingBreaker.fire() as Promise<boolean>;
  }

  private async executeDeduct(
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

  private async executeRestore(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmBalanceResponse> {
    const retryDelays = [1000, 2000, 4000];

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
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
          attempt: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        const delay = retryDelays[attempt];
        if (delay !== undefined) {
          await this.sleep(delay);
        }
      }
    }

    await this.syncLogService.append({
      source: SyncSource.FAILED_RETRY,
      employeeId,
      locationId,
      previousAvailable: 0,
      newAvailable: 0,
      actor: 'hcm-adapter-retry',
      requestId: idempotencyKey,
    });
    this.logger.warn('MANUAL_RECONCILIATION_REQUIRED', { traceId: idempotencyKey });
    throw new HcmUnavailableException(idempotencyKey);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async executePing(): Promise<boolean> {
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
