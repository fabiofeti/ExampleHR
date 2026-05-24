import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from './balance.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Balance])],
})
export class BalancesModule {}
