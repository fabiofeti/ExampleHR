import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './time-off-request.entity';
import { TimeOffRequestsController } from './time-off-requests.controller';
import { TimeOffRequestsService } from './time-off-requests.service';
import { BalancesModule } from '../balances/balances.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequest]), BalancesModule, HcmSyncModule],
  controllers: [TimeOffRequestsController],
  providers: [TimeOffRequestsService],
  exports: [TimeOffRequestsService],
})
export class TimeOffRequestsModule {}
