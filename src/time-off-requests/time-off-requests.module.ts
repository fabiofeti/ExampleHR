import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './time-off-request.entity';
import { TimeOffRequestsService } from './time-off-requests.service';
import { BalancesModule } from '../balances/balances.module';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequest]), BalancesModule],
  providers: [TimeOffRequestsService],
  exports: [TimeOffRequestsService],
})
export class TimeOffRequestsModule {}
