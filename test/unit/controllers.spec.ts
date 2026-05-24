/**
 * Thin unit tests for controllers — verifies routing delegates to services
 * and response DTO mapping is applied. Business logic tested at service layer.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BalancesController } from '../../src/balances/balances.controller';
import { BalancesService } from '../../src/balances/balances.service';
import { Balance } from '../../src/balances/balance.entity';
import { HcmSyncController } from '../../src/hcm-sync/hcm-sync.controller';
import { HcmSyncService } from '../../src/hcm-sync/hcm-sync.service';
import { TimeOffRequestsController } from '../../src/time-off-requests/time-off-requests.controller';
import { TimeOffRequestsService } from '../../src/time-off-requests/time-off-requests.service';
import { TimeOffRequest, RequestStatus } from '../../src/time-off-requests/time-off-request.entity';

// ──────────────────────────────────────────────────────────────────────────
// BalancesController
// ──────────────────────────────────────────────────────────────────────────
describe('BalancesController', () => {
  let controller: BalancesController;
  const mockService = { findOne: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BalancesController],
      providers: [{ provide: BalancesService, useValue: mockService }],
    }).compile();
    controller = module.get(BalancesController);
  });

  it('getBalance: delegates to service and returns mapped DTO', async () => {
    const balance: Balance = {
      employeeId: 'E-1', locationId: 'LOC-1', available: 10, used: 5, total: 15, version: 0,
    } as Balance;
    mockService.findOne.mockResolvedValue(balance);

    const result = await controller.getBalance('E-1', 'LOC-1');

    expect(mockService.findOne).toHaveBeenCalledWith('E-1', 'LOC-1');
    expect(result.employeeId).toBe('E-1');
    expect(result.available).toBe(10);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// HcmSyncController
// ──────────────────────────────────────────────────────────────────────────
describe('HcmSyncController', () => {
  let controller: HcmSyncController;
  const mockService = {
    handleRealtimeUpdate: jest.fn(),
    handleBatchSync: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HcmSyncController],
      providers: [{ provide: HcmSyncService, useValue: mockService }],
    }).compile();
    controller = module.get(HcmSyncController);
  });

  it('handleRealtime: delegates to service', async () => {
    const dto = { employeeId: 'E-1', locationId: 'LOC-1', available: 10, used: 0, total: 10 };
    const result = { updated: 1, invalidated: 0 };
    mockService.handleRealtimeUpdate.mockResolvedValue(result);

    const res = await controller.handleRealtime(dto as any);

    expect(mockService.handleRealtimeUpdate).toHaveBeenCalledWith(dto);
    expect(res).toEqual(result);
  });

  it('handleBatch: passes records array from dto.balances to service', async () => {
    const dto = { balances: [{ employeeId: 'E-1', locationId: 'LOC-1', available: 5, used: 5, total: 10 }] };
    const result = { updated: 1, invalidated: 0, errors: [] };
    mockService.handleBatchSync.mockResolvedValue(result);

    const res = await controller.handleBatch(dto as any);

    expect(mockService.handleBatchSync).toHaveBeenCalledWith({ records: dto.balances });
    expect(res).toEqual(result);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// TimeOffRequestsController
// ──────────────────────────────────────────────────────────────────────────
describe('TimeOffRequestsController', () => {
  let controller: TimeOffRequestsController;
  const mockService = {
    submit: jest.fn(),
    findMany: jest.fn(),
    findOne: jest.fn(),
    approve: jest.fn(),
    reject: jest.fn(),
    cancel: jest.fn(),
  };

  const makeRequest = (status = RequestStatus.PENDING): TimeOffRequest =>
    ({
      id: 'req-1', employeeId: 'E-1', locationId: 'LOC-1', leaveType: 'VACATION',
      startDate: '2026-06-01', endDate: '2026-06-05', days: 5,
      status, rejectionReason: null, createdAt: new Date(), updatedAt: new Date(),
    }) as TimeOffRequest;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TimeOffRequestsController],
      providers: [{ provide: TimeOffRequestsService, useValue: mockService }],
    }).compile();
    controller = module.get(TimeOffRequestsController);
  });

  it('submit: delegates to service and returns mapped DTO', async () => {
    const dto = {
      employeeId: 'E-1', locationId: 'LOC-1', leaveType: 'VACATION',
      startDate: '2026-06-01', endDate: '2026-06-05', days: 5,
    };
    mockService.submit.mockResolvedValue(makeRequest());

    const result = await controller.submit(dto as any);

    expect(mockService.submit).toHaveBeenCalledWith(dto);
    expect(result.id).toBe('req-1');
  });

  it('findMany: delegates to service and maps each item in data array', async () => {
    const page = { data: [makeRequest()], total: 1, page: 1, limit: 10 };
    mockService.findMany.mockResolvedValue(page);

    const result = await controller.findMany({} as any);

    expect(mockService.findMany).toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.data[0]!.id).toBe('req-1');
  });

  it('findOne: returns mapped DTO for single request', async () => {
    mockService.findOne.mockResolvedValue(makeRequest());

    const result = await controller.findOne('req-1');

    expect(mockService.findOne).toHaveBeenCalledWith('req-1');
    expect(result.id).toBe('req-1');
  });

  it('approve: returns approved request', async () => {
    mockService.approve.mockResolvedValue(makeRequest(RequestStatus.APPROVED));

    const result = await controller.approve('req-1', 'trace-1');

    expect(mockService.approve).toHaveBeenCalledWith('req-1', 'trace-1');
    expect(result.status).toBe(RequestStatus.APPROVED);
  });

  it('reject: returns rejected request', async () => {
    mockService.reject.mockResolvedValue(makeRequest(RequestStatus.REJECTED));

    const result = await controller.reject('req-1', { reason: 'no coverage' } as any);

    expect(mockService.reject).toHaveBeenCalledWith('req-1', 'no coverage');
    expect(result.status).toBe(RequestStatus.REJECTED);
  });

  it('cancel: returns cancelled request', async () => {
    mockService.cancel.mockResolvedValue(makeRequest(RequestStatus.CANCELLED));

    const result = await controller.cancel('req-1', 'trace-1');

    expect(mockService.cancel).toHaveBeenCalledWith('req-1', 'trace-1');
    expect(result.status).toBe(RequestStatus.CANCELLED);
  });
});
