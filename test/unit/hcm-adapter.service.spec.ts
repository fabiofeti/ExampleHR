import { ConfigService } from '@nestjs/config';
import { HcmAdapterService } from '../../src/hcm-sync/adapters/hcm-adapter.service';
import {
  HcmRejectionException,
  HcmUnavailableException,
  InsufficientBalanceException,
} from '../../src/common/exceptions';

describe('HcmAdapterService', () => {
  let service: HcmAdapterService;
  let mockPost: jest.Mock;
  let mockGet: jest.Mock;

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
    service = new HcmAdapterService(mockConfig);
    // Replace the real axios instance with controlled mocks
    (service as unknown as { client: unknown }).client = {
      post: mockPost,
      get: mockGet,
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
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
      mockPost.mockRejectedValue(axiosError(422, 'INSUFFICIENT_BALANCE'));

      await expect(service.restore('E-1', 'L-1', 3, 'req-01')).rejects.toThrow(
        HcmUnavailableException,
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
});
