import { ConfigService } from '@nestjs/config';
import { HcmAdapterService } from '../../src/hcm-sync/adapters/hcm-adapter.service';
import {
  HcmRejectionException,
  HcmUnavailableException,
  InsufficientBalanceException,
} from '../../src/common/exceptions';
import { SyncLogService } from '../../src/sync-log/sync-log.service';
import { SyncSource } from '../../src/sync-log/sync-log.entity';

describe('HcmAdapterService', () => {
  let service: HcmAdapterService;
  let mockPost: jest.Mock;
  let mockGet: jest.Mock;
  let mockSyncLogService: jest.Mocked<Pick<SyncLogService, 'append'>>;

  const mockConfig = {
    get: (key: string, defaultVal?: unknown) => {
      if (key === 'HCM_BASE_URL') return 'http://mock-hcm:4000';
      if (key === 'HCM_TIMEOUT_MS') return 5000;
      return defaultVal;
    },
  } as unknown as ConfigService;

  function axiosError(status?: number, code?: string, message?: string): object {
    return {
      isAxiosError: true,
      response: status
        ? { status, data: { code: code ?? 'UNKNOWN', message: message ?? 'error' } }
        : undefined,
    };
  }

  beforeEach(() => {
    mockPost = jest.fn();
    mockGet = jest.fn();
    mockSyncLogService = { append: jest.fn().mockResolvedValue(undefined) };
    service = new HcmAdapterService(
      mockConfig,
      mockSyncLogService as unknown as SyncLogService,
    );
    // Replace the real axios instance with controlled mocks
    (service as unknown as { client: unknown }).client = {
      post: mockPost,
      get: mockGet,
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('deduct()', () => {
    it('U-A-01: returns HcmBalanceResponse and sends X-Idempotency-Key on success', async () => {
      const balance = {
        employeeId: 'E-1',
        locationId: 'L-1',
        available: 5,
        used: 5,
        total: 10,
      };
      mockPost.mockResolvedValue({ data: balance });

      const result = await service.deduct('E-1', 'L-1', 3, 'req-01');

      expect(result).toEqual(balance);
      expect(mockPost).toHaveBeenCalledWith(
        '/hcm/deduct',
        { employeeId: 'E-1', locationId: 'L-1', days: 3 },
        { headers: { 'X-Idempotency-Key': 'req-01-approve' } },
      );
    });

    it('U-A-02: throws InsufficientBalanceException when HCM returns INSUFFICIENT_BALANCE 4xx', async () => {
      mockPost.mockRejectedValue(axiosError(422, 'INSUFFICIENT_BALANCE', 'Not enough days'));

      await expect(service.deduct('E-1', 'L-1', 5, 'req-01')).rejects.toThrow(
        InsufficientBalanceException,
      );
    });

    it('U-A-03: throws HcmRejectionException on other HCM 4xx', async () => {
      mockPost.mockRejectedValue(axiosError(422, 'INVALID_DIMENSION', 'invalid leave type'));

      await expect(service.deduct('E-1', 'L-1', 3, 'req-01')).rejects.toThrow(
        HcmRejectionException,
      );
    });

    it('U-A-04: throws HcmUnavailableException on HCM 5xx', async () => {
      mockPost.mockRejectedValue(axiosError(500));

      await expect(service.deduct('E-1', 'L-1', 3, 'req-01')).rejects.toThrow(
        HcmUnavailableException,
      );
    });

    it('U-A-05: throws HcmUnavailableException on network error (no response)', async () => {
      mockPost.mockRejectedValue({ isAxiosError: true, response: undefined });

      await expect(service.deduct('E-1', 'L-1', 3, 'req-01')).rejects.toThrow(
        HcmUnavailableException,
      );
    });
  });

  describe('restore()', () => {
    it('U-A-06: returns HcmBalanceResponse and sends X-Idempotency-Key on success', async () => {
      const balance = {
        employeeId: 'E-1',
        locationId: 'L-1',
        available: 8,
        used: 2,
        total: 10,
      };
      mockPost.mockResolvedValue({ data: balance });

      const result = await service.restore('E-1', 'L-1', 3, 'req-01');

      expect(result).toEqual(balance);
      expect(mockPost).toHaveBeenCalledWith(
        '/hcm/restore',
        { employeeId: 'E-1', locationId: 'L-1', days: 3 },
        { headers: { 'X-Idempotency-Key': 'req-01-cancel' } },
      );
    });

    it('U-A-07: throws HcmUnavailableException on any restore error (4xx or 5xx)', async () => {
      jest.useFakeTimers();
      mockPost.mockRejectedValue(axiosError(422, 'INSUFFICIENT_BALANCE'));

      const assertion = expect(
        service.restore('E-1', 'L-1', 3, 'req-01'),
      ).rejects.toThrow(HcmUnavailableException);
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('U-A-13 (R-03): succeeds on second attempt after 1s retry delay — no dead-letter written', async () => {
      jest.useFakeTimers();
      const balance = { employeeId: 'E-1', locationId: 'L-1', available: 8, used: 2, total: 10 };
      mockPost
        .mockRejectedValueOnce(axiosError(500))
        .mockResolvedValue({ data: balance });

      // Attach handler before advancing timers to avoid unhandled rejection warning
      const resultPromise = service.restore('E-1', 'L-1', 3, 'req-uuid-retry');
      await jest.runAllTimersAsync();

      const result = await resultPromise;
      expect(result).toEqual(balance);
      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(mockSyncLogService.append).not.toHaveBeenCalled();
    });

    it('U-A-14 (R-04): all 4 attempts exhausted → FAILED_RETRY sync_log written + HcmUnavailableException', async () => {
      jest.useFakeTimers();
      mockPost.mockRejectedValue(axiosError(500));

      // Attach rejection handler BEFORE running timers to prevent unhandled rejection warning
      const assertion = expect(
        service.restore('E-1', 'L-1', 3, 'req-uuid-dead'),
      ).rejects.toThrow(HcmUnavailableException);
      await jest.runAllTimersAsync();
      await assertion;

      expect(mockPost).toHaveBeenCalledTimes(4);
      expect(mockSyncLogService.append).toHaveBeenCalledTimes(1);
      expect(mockSyncLogService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          source: SyncSource.FAILED_RETRY,
          employeeId: 'E-1',
          locationId: 'L-1',
          requestId: 'req-uuid-dead',
          actor: 'hcm-adapter-retry',
          previousAvailable: 0,
          newAvailable: 0,
        }),
      );
    });
  });

  describe('ping()', () => {
    it('U-A-08: returns true when HCM responds', async () => {
      mockGet.mockResolvedValue({ status: 200 });

      await expect(service.ping()).resolves.toBe(true);
    });

    it('U-A-09: returns false on any error — never throws', async () => {
      mockGet.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.ping()).resolves.toBe(false);
    });
  });

  describe('circuit breaker', () => {
    it('U-A-10: deduct() throws HcmUnavailableException when deductBreaker is open — no HTTP call made', async () => {
      // Force the breaker open without firing any HTTP requests
      (service as unknown as { deductBreaker: { open(): void } }).deductBreaker.open();

      await expect(service.deduct('E-1', 'L-1', 3, 'req-10')).rejects.toThrow(
        HcmUnavailableException,
      );
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('U-A-11: restore() throws HcmUnavailableException when restoreBreaker is open — no HTTP call made', async () => {
      // Force the breaker open without firing any HTTP requests
      (service as unknown as { restoreBreaker: { open(): void } }).restoreBreaker.open();

      await expect(service.restore('E-1', 'L-1', 3, 'req-11')).rejects.toThrow(
        HcmUnavailableException,
      );
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('U-A-12: ping() returns false when pingBreaker is open — no HTTP call made', async () => {
      // Force the breaker open without firing any HTTP requests
      (service as unknown as { pingBreaker: { open(): void } }).pingBreaker.open();

      await expect(service.ping()).resolves.toBe(false);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });
});
