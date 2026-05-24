import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './time-off-request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequest])],
})
export class TimeOffRequestsModule {}
