import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TimeOffRequestsService } from '../../src/time-off-requests/time-off-requests.service';
import { TimeOffRequest, RequestStatus } from '../../src/time-off-requests/time-off-request.entity';
import { BalancesService } from '../../src/balances/balances.service';
import { HCM_ADAPTER_TOKEN, IHcmAdapter } from '../../src/hcm-sync/ports/hcm-adapter.port';
import { HcmRejectionException } from '../../src/common/exceptions/hcm-rejection.exception';
import { HcmUnavailableException } from '../../src/common/exceptions/hcm-unavailable.exception';
import { RequestConflictException } from '../../src/common/exceptions/request-conflict.exception';
import { InvalidDateRangeException } from '../../src/common/exceptions/invalid-date-range.exception';
import { Balance } from '../../src/balances/balance.entity';

describe('TimeOffRequestsService', () => {
  let service: TimeOffRequestsService;

  const mockRepo = {
    findOneBy: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockBalancesService = {
    findOne: jest.fn(),
    defensiveCheck: jest.fn(),
    deductWithLock: jest.fn(),
    restoreWithLock: jest.fn(),
  };

  const mockHcmAdapter: jest.Mocked<IHcmAdapter> = {
    deduct: jest.fn(),
    restore: jest.fn(),
    ping: jest.fn(),
  };

  const mockManager = { save: jest.fn() };
  const mockDataSource = {
    transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => Promise<unknown>) => cb(mockManager)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffRequestsService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockRepo },
        { provide: BalancesService, useValue: mockBalancesService },
        { provide: HCM_ADAPTER_TOKEN, useValue: mockHcmAdapter },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<TimeOffRequestsService>(TimeOffRequestsService);
  });

  const makeRequest = (status: RequestStatus, overrides: Partial<TimeOffRequest> = {}): TimeOffRequest =>
    ({
      id: 'req-1',
      employeeId: 'E-1',
      locationId: 'LOC-1',
      leaveType: 'VACATION',
      startDate: '2026-06-01',
      endDate: '2026-06-05',
      days: 5,
      status,
      rejectionReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as TimeOffRequest;

  const makeBalance = (available = 10): Balance =>
    ({ employeeId: 'E-1', locationId: 'LOC-1', available, used: 0, total: available, version: 0 }) as Balance;

  describe('approve', () => {
    it('U-R-01: transitions PENDING request to APPROVED on HCM success', async () => {
      const request = makeRequest(RequestStatus.PENDING);
      mockRepo.findOneBy.mockResolvedValue(request);
      mockBalancesService.findOne.mockResolvedValue(makeBalance());
      mockBalancesService.defensiveCheck.mockReturnValue(undefined);
      mockHcmAdapter.deduct.mockResolvedValue({ employeeId: 'E-1', locationId: 'LOC-1', available: 5, used: 5, total: 10 });
      mockBalancesService.deductWithLock.mockResolvedValue(undefined);
      mockManager.save.mockResolvedValue({ ...request, status: RequestStatus.APPROVED });

      const result = await service.approve('req-1', 'trace-1');

      expect(result.status).toBe(RequestStatus.APPROVED);
      expect(mockHcmAdapter.deduct).toHaveBeenCalledTimes(1);
      expect(mockBalancesService.deductWithLock).toHaveBeenCalledTimes(1);
    });

    it('U-R-02: throws RequestConflictException when request is REJECTED', async () => {
      mockRepo.findOneBy.mockResolvedValue(makeRequest(RequestStatus.REJECTED));

      await expect(service.approve('req-1', 'trace-1')).rejects.toThrow(RequestConflictException);
      expect(mockHcmAdapter.deduct).not.toHaveBeenCalled();
    });

    it('U-R-03: throws RequestConflictException when request is already APPROVED', async () => {
      mockRepo.findOneBy.mockResolvedValue(makeRequest(RequestStatus.APPROVED));

      await expect(service.approve('req-1', 'trace-1')).rejects.toThrow(RequestConflictException);
      expect(mockHcmAdapter.deduct).not.toHaveBeenCalled();
    });

    it('U-R-04: throws HcmRejectionException when HCM returns a rejection; balance unchanged', async () => {
      mockRepo.findOneBy.mockResolvedValue(makeRequest(RequestStatus.PENDING));
      mockBalancesService.findOne.mockResolvedValue(makeBalance());
      mockBalancesService.defensiveCheck.mockReturnValue(undefined);
      mockHcmAdapter.deduct.mockRejectedValue(new HcmRejectionException('invalid leave type'));

      await expect(service.approve('req-1', 'trace-1')).rejects.toThrow(HcmRejectionException);
      expect(mockBalancesService.deductWithLock).not.toHaveBeenCalled();
    });

    it('U-R-05: throws HcmUnavailableException when HCM times out; balance unchanged', async () => {
      mockRepo.findOneBy.mockResolvedValue(makeRequest(RequestStatus.PENDING));
      mockBalancesService.findOne.mockResolvedValue(makeBalance());
      mockBalancesService.defensiveCheck.mockReturnValue(undefined);
      mockHcmAdapter.deduct.mockRejectedValue(new HcmUnavailableException('trace-1'));

      await expect(service.approve('req-1', 'trace-1')).rejects.toThrow(HcmUnavailableException);
      expect(mockBalancesService.deductWithLock).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('U-R-06: transitions PENDING request to REJECTED; no HCM call', async () => {
      const request = makeRequest(RequestStatus.PENDING);
      mockRepo.findOneBy.mockResolvedValue(request);
      mockRepo.save.mockResolvedValue({ ...request, status: RequestStatus.REJECTED });

      const result = await service.reject('req-1', 'not needed');

      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(mockHcmAdapter.deduct).not.toHaveBeenCalled();
      expect(mockBalancesService.deductWithLock).not.toHaveBeenCalled();
    });

    it('U-R-07: throws RequestConflictException when request is APPROVED', async () => {
      mockRepo.findOneBy.mockResolvedValue(makeRequest(RequestStatus.APPROVED));

      await expect(service.reject('req-1')).rejects.toThrow(RequestConflictException);
    });
  });

  describe('cancel', () => {
    it('U-R-08: transitions APPROVED request to CANCELLED on HCM success; balance restored', async () => {
      const request = makeRequest(RequestStatus.APPROVED);
      mockRepo.findOneBy.mockResolvedValue(request);
      mockHcmAdapter.restore.mockResolvedValue({ employeeId: 'E-1', locationId: 'LOC-1', available: 10, used: 0, total: 10 });
      mockBalancesService.restoreWithLock.mockResolvedValue(undefined);
      mockManager.save.mockResolvedValue({ ...request, status: RequestStatus.CANCELLED });

      const result = await service.cancel('req-1', 'trace-1');

      expect(result.status).toBe(RequestStatus.CANCELLED);
      expect(mockHcmAdapter.restore).toHaveBeenCalledTimes(1);
      expect(mockBalancesService.restoreWithLock).toHaveBeenCalledTimes(1);
    });

    it('U-R-09: throws RequestConflictException when request is PENDING', async () => {
      mockRepo.findOneBy.mockResolvedValue(makeRequest(RequestStatus.PENDING));

      await expect(service.cancel('req-1', 'trace-1')).rejects.toThrow(RequestConflictException);
      expect(mockHcmAdapter.restore).not.toHaveBeenCalled();
    });

    it('U-R-10: throws HcmUnavailableException when HCM restore times out; status unchanged', async () => {
      mockRepo.findOneBy.mockResolvedValue(makeRequest(RequestStatus.APPROVED));
      mockHcmAdapter.restore.mockRejectedValue(new HcmUnavailableException('trace-1'));

      await expect(service.cancel('req-1', 'trace-1')).rejects.toThrow(HcmUnavailableException);
      expect(mockBalancesService.restoreWithLock).not.toHaveBeenCalled();
    });
  });

  describe('submit', () => {
    const makeQb = (overlapResult: TimeOffRequest | null = null) => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(overlapResult),
    });

    const baseDto = {
      employeeId: 'E-1', locationId: 'LOC-1', leaveType: 'VACATION',
      startDate: '2026-06-01', endDate: '2026-06-05', days: 5,
    };

    it('U-R-11: throws InvalidDateRangeException when endDate < startDate', async () => {
      await expect(service.submit({ ...baseDto, startDate: '2026-06-10', endDate: '2026-06-01' }))
        .rejects.toThrow(InvalidDateRangeException);
    });

    it('U-R-12: throws RequestConflictException when overlapping PENDING request exists', async () => {
      mockBalancesService.findOne.mockResolvedValue(makeBalance());
      mockBalancesService.defensiveCheck.mockReturnValue(undefined);
      mockRepo.createQueryBuilder.mockReturnValue(makeQb(makeRequest(RequestStatus.PENDING)));

      await expect(service.submit(baseDto)).rejects.toThrow(RequestConflictException);
    });

    it('U-R-13: creates PENDING request when balance sufficient and no overlap', async () => {
      const saved = makeRequest(RequestStatus.PENDING);
      mockBalancesService.findOne.mockResolvedValue(makeBalance());
      mockBalancesService.defensiveCheck.mockReturnValue(undefined);
      mockRepo.createQueryBuilder.mockReturnValue(makeQb(null));
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);

      const result = await service.submit(baseDto);

      expect(result.status).toBe(RequestStatus.PENDING);
      expect(mockRepo.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('findOne', () => {
    it('U-R-14: throws NotFoundException when request does not exist', async () => {
      mockRepo.findOneBy.mockResolvedValue(null);

      await expect(service.findOne('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findMany', () => {
    const makeQb = () => {
      const qb = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      return qb;
    };

    it('U-R-15: returns paginated results with no optional filters (all false branches)', async () => {
      const qb = makeQb();
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findMany({ page: 1, limit: 10 });

      expect(result.total).toBe(0);
      expect(result.data).toHaveLength(0);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('U-R-16: applies all optional filters when provided (all true branches)', async () => {
      const qb = makeQb();
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findMany({
        employeeId: 'E-1', locationId: 'LOC-1', status: RequestStatus.PENDING,
        startDate: '2026-06-01', endDate: '2026-06-30', page: 2, limit: 5,
      });

      expect(qb.andWhere).toHaveBeenCalledTimes(5);
      expect(qb.skip).toHaveBeenCalledWith(5); // (2-1) * 5
      expect(qb.take).toHaveBeenCalledWith(5);
      expect(result.page).toBe(2);
    });
  });
});
