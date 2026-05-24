import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TimeOffRequestsService } from '../../src/time-off-requests/time-off-requests.service';
import { TimeOffRequest, RequestStatus } from '../../src/time-off-requests/time-off-request.entity';
import { Balance } from '../../src/balances/balance.entity';
import { SyncLog } from '../../src/sync-log/sync-log.entity';
import { BalancesService } from '../../src/balances/balances.service';
import { SyncLogService } from '../../src/sync-log/sync-log.service';
import { HCM_ADAPTER_TOKEN } from '../../src/hcm-sync/ports/hcm-adapter.port';
import { RequestConflictException } from '../../src/common/exceptions/request-conflict.exception';

describe('TimeOffRequestsService (integration)', () => {
  let module: TestingModule;
  let service: TimeOffRequestsService;
  let dataSource: DataSource;

  const mockHcmAdapter = { deduct: jest.fn(), restore: jest.fn(), ping: jest.fn() };
  // DataSource.transaction mock: executes the callback with the real entity manager
  // (transaction is not needed for submit — only approve/cancel use it)
  let mockDataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [TimeOffRequest, Balance, SyncLog],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([TimeOffRequest, Balance, SyncLog]),
      ],
      providers: [
        TimeOffRequestsService,
        BalancesService,
        SyncLogService,
        { provide: HCM_ADAPTER_TOKEN, useValue: mockHcmAdapter },
      ],
    }).compile();

    service = module.get<TimeOffRequestsService>(TimeOffRequestsService);
    dataSource = module.get<DataSource>(DataSource);

    // Replace DataSource with a passthrough mock so submit() works normally
    // (submit does not use transactions; approve/cancel are not tested here)
    mockDataSource = { transaction: jest.fn() };
    Object.defineProperty(service, 'dataSource', { value: mockDataSource, writable: true });
  });

  afterEach(async () => {
    await module.close();
  });

  const seedBalance = async (employeeId: string, locationId: string, available = 20): Promise<void> => {
    await dataSource.query(
      `INSERT INTO balances (employee_id, location_id, available, used, total, version)
       VALUES (?, ?, ?, 0, ?, 0)`,
      [employeeId, locationId, available, available],
    );
  };

  const seedRequest = async (
    employeeId: string,
    locationId: string,
    startDate: string,
    endDate: string,
    status: RequestStatus = RequestStatus.PENDING,
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO time_off_requests
         (id, employee_id, location_id, leave_type, start_date, end_date, days, status, rejection_reason)
       VALUES (?, ?, ?, 'VACATION', ?, ?, 5, ?, NULL)`,
      [`existing-req-${Date.now()}`, employeeId, locationId, startDate, endDate, status],
    );
  };

  describe('I-01: overlapping request is rejected with RequestConflictException', () => {
    it('throws when new request date range overlaps an existing PENDING request', async () => {
      await seedBalance('E-1', 'LOC-1');
      await seedRequest('E-1', 'LOC-1', '2026-06-01', '2026-06-10');

      await expect(
        service.submit({
          employeeId: 'E-1',
          locationId: 'LOC-1',
          leaveType: 'VACATION',
          startDate: '2026-06-05',
          endDate: '2026-06-15',
          days: 11,
        }),
      ).rejects.toThrow(RequestConflictException);
    });

    it('throws when new request is entirely contained within an existing APPROVED request', async () => {
      await seedBalance('E-1', 'LOC-1');
      await seedRequest('E-1', 'LOC-1', '2026-07-01', '2026-07-20', RequestStatus.APPROVED);

      await expect(
        service.submit({
          employeeId: 'E-1',
          locationId: 'LOC-1',
          leaveType: 'VACATION',
          startDate: '2026-07-05',
          endDate: '2026-07-10',
          days: 5,
        }),
      ).rejects.toThrow(RequestConflictException);
    });
  });

  describe('I-02: adjacent request (end == next start) is allowed', () => {
    it('creates a new PENDING request when its startDate equals the endDate of an existing request', async () => {
      await seedBalance('E-1', 'LOC-1');
      await seedRequest('E-1', 'LOC-1', '2026-06-01', '2026-06-10');

      const result = await service.submit({
        employeeId: 'E-1',
        locationId: 'LOC-1',
        leaveType: 'VACATION',
        startDate: '2026-06-10',
        endDate: '2026-06-15',
        days: 5,
      });

      expect(result.status).toBe(RequestStatus.PENDING);
      expect(result.startDate).toBe('2026-06-10');
    });
  });
});
