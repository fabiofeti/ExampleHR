import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HcmAdapterService } from './adapters/hcm-adapter.service';
import { HcmSyncService } from './hcm-sync.service';
import { HCM_ADAPTER_TOKEN } from './ports/hcm-adapter.port';
import { Balance } from '../balances/balance.entity';
import { TimeOffRequest } from '../time-off-requests/time-off-request.entity';
import { SyncLogModule } from '../sync-log/sync-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([Balance, TimeOffRequest]), SyncLogModule],
  providers: [
    { provide: HCM_ADAPTER_TOKEN, useClass: HcmAdapterService },
    HcmSyncService,
  ],
  exports: [HCM_ADAPTER_TOKEN, HcmSyncService],
})
export class HcmSyncModule {}
