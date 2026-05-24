import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncLog, SyncSource } from './sync-log.entity';

export interface AppendSyncLogParams {
  employeeId: string;
  locationId: string;
  source: SyncSource;
  previousAvailable: number;
  newAvailable: number;
  actor: string;
  requestId: string | null;
}

@Injectable()
export class SyncLogService {
  constructor(
    @InjectRepository(SyncLog)
    private readonly repo: Repository<SyncLog>,
  ) {}

  async append(params: AppendSyncLogParams): Promise<void> {
    await this.repo.save(this.repo.create(params));
  }
}
