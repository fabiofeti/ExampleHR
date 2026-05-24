import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BalancesService } from '../../src/balances/balances.service';
import { Balance } from '../../src/balances/balance.entity';
import { SyncLogService } from '../../src/sync-log/sync-log.service';
import { BalanceConflictException } from '../../src/common/exceptions/balance-conflict.exception';
import { InsufficientBalanceException } from '../../src/common/exceptions/insufficient-balance.exception';

describe('BalancesService', () => {
  let service: BalancesService;

  const mockExecute = jest.fn();
  const mockQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: mockExecute,
  };
  const mockRepo = {
    findOneBy: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(mockQb),
  };
  const mockSyncLog = {
    append: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockQb.update.mockReturnThis();
    mockQb.set.mockReturnThis();
    mockQb.where.mockReturnThis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalancesService,
        { provide: getRepositoryToken(Balance), useValue: mockRepo },
        { provide: SyncLogService, useValue: mockSyncLog },
      ],
    }).compile();

    service = module.get<BalancesService>(BalancesService);
  });

  const makeBalance = (available: number, version = 0): Balance =>
    ({
      employeeId: 'E-1',
      locationId: 'LOC-1',
      available,
      used: 0,
      total: available,
      version,
    }) as Balance;

  describe('defensiveCheck', () => {
    it('U-B-01: does not throw when available equals days', () => {
      expect(() => service.defensiveCheck(makeBalance(5), 5)).not.toThrow();
    });

    it('U-B-02: throws InsufficientBalanceException when available < days', () => {
      expect(() => service.defensiveCheck(makeBalance(3), 5)).toThrow(
        InsufficientBalanceException,
      );
    });

    it('U-B-03: does not throw when available > days', () => {
      expect(() => service.defensiveCheck(makeBalance(10), 3)).not.toThrow();
    });
  });

  describe('findOne', () => {
    it('U-B-04: throws NotFoundException when no balance record exists', async () => {
      mockRepo.findOneBy.mockResolvedValue(null);
      await expect(service.findOne('E-1', 'LOC-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deductWithLock', () => {
    it('U-B-05: throws BalanceConflictException when both update attempts return 0 rows', async () => {
      mockRepo.findOneBy.mockResolvedValue(makeBalance(10));
      mockExecute.mockResolvedValue({ affected: 0 });

      await expect(
        service.deductWithLock('E-1', 'LOC-1', 3, 'req-1', 'system'),
      ).rejects.toThrow(BalanceConflictException);

      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockSyncLog.append).not.toHaveBeenCalled();
    });

    it('U-B-06: resolves and logs sync entry when first attempt fails but retry succeeds', async () => {
      mockRepo.findOneBy.mockResolvedValue(makeBalance(10));
      mockExecute
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 1 });

      await expect(
        service.deductWithLock('E-1', 'LOC-1', 3, 'req-1', 'system'),
      ).resolves.toBeUndefined();

      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockSyncLog.append).toHaveBeenCalledTimes(1);
    });
  });
});
