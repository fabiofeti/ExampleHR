import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from './balance.entity';
import { BalancesController } from './balances.controller';
import { BalancesService } from './balances.service';
import { SyncLogModule } from '../sync-log/sync-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([Balance]), SyncLogModule],
  controllers: [BalancesController],
  providers: [BalancesService],
  exports: [BalancesService],
})
export class BalancesModule {}
