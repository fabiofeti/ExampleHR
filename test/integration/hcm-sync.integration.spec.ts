import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { HcmSyncService, BatchSyncDto } from '../../src/hcm-sync/hcm-sync.service';
import { Balance } from '../../src/balances/balance.entity';
import { TimeOffRequest, RequestStatus } from '../../src/time-off-requests/time-off-request.entity';
import { SyncLog, SyncSource } from '../../src/sync-log/sync-log.entity';
import { SyncLogService } from '../../src/sync-log/sync-log.service';

describe('HcmSyncService (integration)', () => {
  let module: TestingModule;
  let service: HcmSyncService;
  let dataSource: DataSource;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [Balance, SyncLog, TimeOffRequest],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([Balance, SyncLog, TimeOffRequest]),
      ],
      providers: [HcmSyncService, SyncLogService],
    }).compile();

    service = module.get<HcmSyncService>(HcmSyncService);
    dataSource = module.get<DataSource>(DataSource);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('I-04: batch idempotency — sync_log written only when available changes', () => {
    it('running the same batch payload twice writes exactly one BATCH sync_log row', async () => {
      const dto: BatchSyncDto = {
        records: [
          { employeeId: 'E-1', locationId: 'L-1', available: 8, used: 2, total: 10 },
        ],
      };

      await service.handleBatchSync(dto);
      await service.handleBatchSync(dto); // second run — same payload

      const balances = await dataSource.query(
        `SELECT * FROM balances WHERE employee_id='E-1' AND location_id='L-1'`,
      ) as { available: number; version: number }[];
      const balance = balances[0];
      expect(balance?.available).toBe(8);
      expect(balance?.version).toBe(2); // version bumped on each save

      const logs = await dataSource.query(
        `SELECT * FROM sync_log WHERE employee_id='E-1' AND source='${SyncSource.BATCH}'`,
      ) as unknown[];
      expect(logs).toHaveLength(1); // only the first run wrote a BATCH log
    });
  });

  describe('I-05: reconciliation filters correctly', () => {
    it('invalidates PENDING/APPROVED requests where days > available; ignores REJECTED', async () => {
      // Seed balance at available=10 first
      await dataSource.query(
        `INSERT INTO balances (employee_id, location_id, available, used, total, version)
         VALUES ('E-1', 'L-1', 10, 0, 10, 0)`,
      );

      // Three requests: PENDING (days=8), APPROVED (days=3), REJECTED (days=12)
      await dataSource.query(
        `INSERT INTO time_off_requests
           (id, employee_id, location_id, leave_type, start_date, end_date, days, status)
         VALUES
           ('R-PENDING',  'E-1', 'L-1', 'annual', '2026-07-01', '2026-07-08', 8,  '${RequestStatus.PENDING}'),
           ('R-APPROVED', 'E-1', 'L-1', 'annual', '2026-08-01', '2026-08-03', 3,  '${RequestStatus.APPROVED}'),
           ('R-REJECTED', 'E-1', 'L-1', 'annual', '2026-09-01', '2026-09-10', 12, '${RequestStatus.REJECTED}')`,
      );

      // Batch lowers available from 10 → 5
      const result = await service.handleBatchSync({
        records: [{ employeeId: 'E-1', locationId: 'L-1', available: 5, used: 5, total: 10 }],
      });

      // days=8 > 5 → INVALIDATED
      const [pending] = await dataSource.query(
        `SELECT status FROM time_off_requests WHERE id='R-PENDING'`,
      ) as [{ status: string }];
      // days=3 ≤ 5 → stays APPROVED
      const [approved] = await dataSource.query(
        `SELECT status FROM time_off_requests WHERE id='R-APPROVED'`,
      ) as [{ status: string }];
      // REJECTED never enters reconciliation
      const [rejected] = await dataSource.query(
        `SELECT status FROM time_off_requests WHERE id='R-REJECTED'`,
      ) as [{ status: string }];

      expect(pending?.status).toBe(RequestStatus.INVALIDATED);
      expect(approved?.status).toBe(RequestStatus.APPROVED);
      expect(rejected?.status).toBe(RequestStatus.REJECTED);
      expect(result.invalidated).toBe(1);
    });
  });
});
