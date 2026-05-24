import { Repository, DataSource } from 'typeorm';
import {
  HcmSyncService,
  RealtimeUpdateDto,
  BatchSyncDto,
} from '../../src/hcm-sync/hcm-sync.service';
import { Balance } from '../../src/balances/balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/time-off-requests/time-off-request.entity';
import { SyncLog, SyncSource } from '../../src/sync-log/sync-log.entity';
import { SyncLogService } from '../../src/sync-log/sync-log.service';

describe('HcmSyncService', () => {
  let service: HcmSyncService;
  let balanceRepo: { findOneBy: jest.Mock; save: jest.Mock };
  let requestRepo: { find: jest.Mock; save: jest.Mock; createQueryBuilder: jest.Mock };
  let syncLogService: { append: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(() => {
    balanceRepo = { findOneBy: jest.fn(), save: jest.fn() };
    requestRepo = { find: jest.fn(), save: jest.fn(), createQueryBuilder: jest.fn() };
    syncLogService = { append: jest.fn() };
    dataSource = { transaction: jest.fn() };
    service = new HcmSyncService(
      balanceRepo as unknown as Repository<Balance>,
      requestRepo as unknown as Repository<TimeOffRequest>,
      syncLogService as unknown as SyncLogService,
      dataSource as unknown as DataSource,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── handleRealtimeUpdate ──────────────────────────────────────────────────

  describe('handleRealtimeUpdate()', () => {
    const dto: RealtimeUpdateDto = {
      employeeId: 'E-1',
      locationId: 'L-1',
      available: 8,
      used: 2,
      total: 10,
    };

    it('U-S-01: updates existing balance and appends REALTIME_WEBHOOK sync_log when available changes', async () => {
      balanceRepo.findOneBy.mockResolvedValue({ available: 10, version: 2 });
      balanceRepo.save.mockResolvedValue(undefined);
      requestRepo.find.mockResolvedValue([]);
      syncLogService.append.mockResolvedValue(undefined);

      const result = await service.handleRealtimeUpdate(dto);

      expect(balanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ available: 8, version: 3 }),
      );
      expect(syncLogService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          source: SyncSource.REALTIME_WEBHOOK,
          previousAvailable: 10,
          newAvailable: 8,
          actor: 'hcm-webhook',
          requestId: null,
        }),
      );
      expect(result).toEqual({ updated: 1, invalidated: 0 });
    });

    it('U-S-02: upserts new balance when none exists; treats previousAvailable as 0', async () => {
      const newDto: RealtimeUpdateDto = {
        employeeId: 'E-2',
        locationId: 'L-1',
        available: 10,
        used: 0,
        total: 10,
      };
      balanceRepo.findOneBy.mockResolvedValue(null);
      balanceRepo.save.mockResolvedValue(undefined);
      requestRepo.find.mockResolvedValue([]);
      syncLogService.append.mockResolvedValue(undefined);

      const result = await service.handleRealtimeUpdate(newDto);

      expect(balanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ version: 1 }),
      );
      expect(syncLogService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          source: SyncSource.REALTIME_WEBHOOK,
          previousAvailable: 0,
          newAvailable: 10,
        }),
      );
      expect(result).toEqual({ updated: 1, invalidated: 0 });
    });

    it('U-S-03: skips sync_log when available is unchanged', async () => {
      const sameDto: RealtimeUpdateDto = { employeeId: 'E-1', locationId: 'L-1', available: 10, used: 0, total: 10 };
      balanceRepo.findOneBy.mockResolvedValue({ available: 10, version: 1 });
      balanceRepo.save.mockResolvedValue(undefined);
      requestRepo.find.mockResolvedValue([]);

      const result = await service.handleRealtimeUpdate(sameDto);

      expect(balanceRepo.save).toHaveBeenCalled();
      expect(syncLogService.append).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: 1, invalidated: 0 });
    });

    it('U-S-04: invalidates PENDING/APPROVED requests with days > new balance; leaves others untouched', async () => {
      balanceRepo.findOneBy.mockResolvedValue({ available: 10, version: 1 });
      balanceRepo.save.mockResolvedValue(undefined);
      const pending: Partial<TimeOffRequest> = {
        id: 'R-1', employeeId: 'E-1', locationId: 'L-1', days: 8, status: RequestStatus.PENDING,
      };
      const approved: Partial<TimeOffRequest> = {
        id: 'R-2', employeeId: 'E-1', locationId: 'L-1', days: 3, status: RequestStatus.APPROVED,
      };
      requestRepo.find.mockResolvedValue([pending, approved]);
      requestRepo.save.mockResolvedValue(undefined);
      syncLogService.append.mockResolvedValue(undefined);

      // available drops to 5: days=8 > 5 → INVALIDATED; days=3 ≤ 5 → kept
      const result = await service.handleRealtimeUpdate({ ...dto, available: 5 });

      expect(requestRepo.save).toHaveBeenCalledTimes(1);
      expect(requestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'R-1', status: RequestStatus.INVALIDATED }),
      );
      expect(syncLogService.append).toHaveBeenCalledWith(
        expect.objectContaining({ source: SyncSource.INVALIDATION, requestId: 'R-1' }),
      );
      expect(result).toEqual({ updated: 1, invalidated: 1 });
    });

    it('U-S-05: queries only PENDING and APPROVED statuses; REJECTED/CANCELLED never reach filter', async () => {
      balanceRepo.findOneBy.mockResolvedValue({ available: 10, version: 1 });
      balanceRepo.save.mockResolvedValue(undefined);
      requestRepo.find.mockResolvedValue([]); // DB correctly excludes other statuses

      await service.handleRealtimeUpdate({ ...dto, available: 5 });

      expect(requestRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.arrayContaining([
            expect.objectContaining({ status: RequestStatus.PENDING }),
            expect.objectContaining({ status: RequestStatus.APPROVED }),
          ]),
        }),
      );
      // exactly 2 status conditions — no REJECTED or CANCELLED
      const call = requestRepo.find.mock.calls[0] as [{ where: unknown[] }];
      expect(call[0].where).toHaveLength(2);
    });
  });

  // ── handleBatchSync ───────────────────────────────────────────────────────

  describe('handleBatchSync()', () => {
    let fakeBalanceRepo: { findOneBy: jest.Mock; save: jest.Mock };
    let fakeRequestRepo: { save: jest.Mock; createQueryBuilder: jest.Mock };
    let fakeManager: { getRepository: jest.Mock; save: jest.Mock };

    function makeQb(results: Partial<TimeOffRequest>[] = []) {
      return {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(results),
      };
    }

    beforeEach(() => {
      fakeBalanceRepo = { findOneBy: jest.fn(), save: jest.fn() };
      fakeRequestRepo = { save: jest.fn(), createQueryBuilder: jest.fn() };
      fakeManager = {
        getRepository: jest.fn().mockImplementation((entity: unknown) => {
          if (entity === Balance) return fakeBalanceRepo;
          if (entity === TimeOffRequest) return fakeRequestRepo;
          return {};
        }),
        save: jest.fn(),
      };
      dataSource.transaction.mockImplementation(
        (cb: (m: typeof fakeManager) => Promise<void>) => cb(fakeManager),
      );
    });

    it('U-S-06: upserts all records inside a single transaction', async () => {
      fakeBalanceRepo.findOneBy.mockResolvedValue(null);
      fakeBalanceRepo.save.mockResolvedValue(undefined);
      fakeManager.save.mockResolvedValue(undefined);
      fakeRequestRepo.createQueryBuilder.mockReturnValue(makeQb());

      const dto: BatchSyncDto = {
        records: [
          { employeeId: 'E-1', locationId: 'L-1', available: 8, used: 2, total: 10 },
          { employeeId: 'E-2', locationId: 'L-1', available: 5, used: 0, total: 5 },
        ],
      };

      const result = await service.handleBatchSync(dto);

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(fakeBalanceRepo.save).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ updated: 2, invalidated: 0, errors: [] });
    });

    it('U-S-07: skips sync_log entry when available is unchanged (idempotency guard)', async () => {
      fakeBalanceRepo.findOneBy.mockResolvedValue({
        employeeId: 'E-1', locationId: 'L-1', available: 10, version: 1,
      });
      fakeBalanceRepo.save.mockResolvedValue(undefined);
      fakeManager.save.mockResolvedValue(undefined);
      fakeRequestRepo.createQueryBuilder.mockReturnValue(makeQb());

      await service.handleBatchSync({
        records: [{ employeeId: 'E-1', locationId: 'L-1', available: 10, used: 0, total: 10 }],
      });

      // No BATCH sync_log, no reconciliation saves — manager.save must not be called
      expect(fakeManager.save).not.toHaveBeenCalled();
    });

    it('U-S-08: reconciles all PENDING/APPROVED across employees and marks over-budget ones INVALIDATED', async () => {
      fakeBalanceRepo.findOneBy.mockResolvedValue({
        employeeId: 'E-1', locationId: 'L-1', available: 5, version: 1,
      });
      fakeBalanceRepo.save.mockResolvedValue(undefined);
      fakeManager.save.mockResolvedValue(undefined);

      const pendingReq: Partial<TimeOffRequest> = {
        id: 'R-1', employeeId: 'E-1', locationId: 'L-1', days: 8, status: RequestStatus.PENDING,
      };
      fakeRequestRepo.createQueryBuilder.mockReturnValue(makeQb([pendingReq]));
      fakeRequestRepo.save.mockResolvedValue(undefined);

      const result = await service.handleBatchSync({
        records: [{ employeeId: 'E-1', locationId: 'L-1', available: 5, used: 5, total: 10 }],
      });

      expect(fakeRequestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'R-1', status: RequestStatus.INVALIDATED }),
      );
      expect(fakeManager.save).toHaveBeenCalledWith(
        SyncLog,
        expect.objectContaining({ source: SyncSource.INVALIDATION, requestId: 'R-1' }),
      );
      expect(result).toEqual({ updated: 1, invalidated: 1, errors: [] });
    });
  });
});
