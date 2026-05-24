import { Body, Controller, Post } from '@nestjs/common';
import { BatchSyncDto } from './dto/batch-sync.dto';
import { RealtimeSyncDto } from './dto/realtime-sync.dto';
import { BatchSyncResult, HcmSyncService, SyncResult } from './hcm-sync.service';

@Controller('hcm/sync')
export class HcmSyncController {
  constructor(private readonly hcmSyncService: HcmSyncService) {}

  @Post('realtime')
  handleRealtime(@Body() dto: RealtimeSyncDto): Promise<SyncResult> {
    return this.hcmSyncService.handleRealtimeUpdate(dto);
  }

  @Post('batch')
  handleBatch(@Body() dto: BatchSyncDto): Promise<BatchSyncResult> {
    return this.hcmSyncService.handleBatchSync({ records: dto.balances });
  }
}
