import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Balance } from '../balances/balance.entity';
import { TimeOffRequest, RequestStatus } from '../time-off-requests/time-off-request.entity';
import { SyncLog, SyncSource } from '../sync-log/sync-log.entity';
import { SyncLogService } from '../sync-log/sync-log.service';

export interface RealtimeUpdateDto {
  employeeId: string;
  locationId: string;
  available: number;
  used: number;
  total: number;
}

export interface BatchRecord {
  employeeId: string;
  locationId: string;
  available: number;
  used: number;
  total: number;
}

export interface BatchSyncDto {
  records: BatchRecord[];
}

export interface SyncResult {
  updated: number;
  invalidated: number;
}

export interface BatchSyncResult {
  updated: number;
  invalidated: number;
  errors: string[];
}

@Injectable()
export class HcmSyncService {
  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly syncLogService: SyncLogService,
    private readonly dataSource: DataSource,
  ) {}

  async handleRealtimeUpdate(dto: RealtimeUpdateDto): Promise<SyncResult> {
    const existing = await this.balanceRepo.findOneBy({
      employeeId: dto.employeeId,
      locationId: dto.locationId,
    });
    const previousAvailable = existing?.available ?? 0;

    await this.balanceRepo.save({
      ...dto,
      version: (existing?.version ?? 0) + 1,
      lastSyncedAt: new Date(),
    });

    if (previousAvailable !== dto.available) {
      await this.syncLogService.append({
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        source: SyncSource.REALTIME_WEBHOOK,
        previousAvailable,
        newAvailable: dto.available,
        actor: 'hcm-webhook',
        requestId: null,
      });
    }

    const candidates = await this.requestRepo.find({
      where: [
        { employeeId: dto.employeeId, locationId: dto.locationId, status: RequestStatus.PENDING },
        { employeeId: dto.employeeId, locationId: dto.locationId, status: RequestStatus.APPROVED },
      ],
    });
    const toInvalidate = candidates.filter((r) => r.days > dto.available);

    for (const req of toInvalidate) {
      req.status = RequestStatus.INVALIDATED;
      await this.requestRepo.save(req);
      await this.syncLogService.append({
        employeeId: req.employeeId,
        locationId: req.locationId,
        source: SyncSource.INVALIDATION,
        previousAvailable: dto.available,
        newAvailable: dto.available,
        actor: 'hcm-sync',
        requestId: req.id,
      });
    }

    return { updated: 1, invalidated: toInvalidate.length };
  }

  async handleBatchSync(dto: BatchSyncDto): Promise<BatchSyncResult> {
    let updated = 0;
    let invalidated = 0;

    await this.dataSource.transaction(async (manager) => {
      const balanceRepo = manager.getRepository(Balance);
      const requestRepo = manager.getRepository(TimeOffRequest);

      for (const record of dto.records) {
        const existing = await balanceRepo.findOneBy({
          employeeId: record.employeeId,
          locationId: record.locationId,
        });
        const previousAvailable = existing?.available ?? 0;

        await balanceRepo.save({
          ...record,
          version: (existing?.version ?? 0) + 1,
          lastSyncedAt: new Date(),
        });
        updated++;

        if (previousAvailable !== record.available) {
          await manager.save(SyncLog, {
            employeeId: record.employeeId,
            locationId: record.locationId,
            source: SyncSource.BATCH,
            previousAvailable,
            newAvailable: record.available,
            actor: 'hcm-batch',
            requestId: null,
          });
        }
      }

      const toInvalidate = await requestRepo
        .createQueryBuilder('r')
        .innerJoin(Balance, 'b', 'b.employee_id = r.employee_id AND b.location_id = r.location_id')
        .where('r.status IN (:...statuses)', {
          statuses: [RequestStatus.PENDING, RequestStatus.APPROVED],
        })
        .andWhere('r.days > b.available')
        .getMany();

      for (const req of toInvalidate) {
        const balance = await balanceRepo.findOneBy({
          employeeId: req.employeeId,
          locationId: req.locationId,
        });
        req.status = RequestStatus.INVALIDATED;
        await requestRepo.save(req);
        await manager.save(SyncLog, {
          employeeId: req.employeeId,
          locationId: req.locationId,
          source: SyncSource.INVALIDATION,
          previousAvailable: balance?.available ?? 0,
          newAvailable: balance?.available ?? 0,
          actor: 'hcm-sync',
          requestId: req.id,
        });
        invalidated++;
      }
    });

    return { updated, invalidated, errors: [] };
  }
}
