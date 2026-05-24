import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncLog } from './sync-log.entity';
import { SyncLogService } from './sync-log.service';

@Module({
  imports: [TypeOrmModule.forFeature([SyncLog])],
  providers: [SyncLogService],
  exports: [SyncLogService],
})
export class SyncLogModule {}
