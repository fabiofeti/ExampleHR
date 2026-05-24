import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Balance } from './balance.entity';
import { SyncLogService } from '../sync-log/sync-log.service';
import { SyncSource } from '../sync-log/sync-log.entity';
import { InsufficientBalanceException } from '../common/exceptions/insufficient-balance.exception';
import { BalanceConflictException } from '../common/exceptions/balance-conflict.exception';

@Injectable()
export class BalancesService {
  constructor(
    @InjectRepository(Balance)
    private readonly repo: Repository<Balance>,
    private readonly syncLogService: SyncLogService,
  ) {}

  async findOne(employeeId: string, locationId: string): Promise<Balance> {
    const balance = await this.repo.findOneBy({ employeeId, locationId });
    if (!balance) {
      throw new NotFoundException(
        `Balance not found for employee ${employeeId} at location ${locationId}`,
      );
    }
    return balance;
  }

  defensiveCheck(balance: Balance, days: number): void {
    if (balance.available < days) {
      throw new InsufficientBalanceException(balance.available, days);
    }
  }

  async deductWithLock(
    employeeId: string,
    locationId: string,
    days: number,
    requestId: string,
    actor: string,
  ): Promise<void> {
    let balance = await this.findOne(employeeId, locationId);
    let success = await this.tryUpdate(balance, days, 'deduct');

    if (!success) {
      balance = await this.findOne(employeeId, locationId);
      success = await this.tryUpdate(balance, days, 'deduct');
      if (!success) {
        throw new BalanceConflictException();
      }
    }

    await this.syncLogService.append({
      employeeId,
      locationId,
      source: SyncSource.REQUEST_APPROVE,
      previousAvailable: balance.available,
      newAvailable: balance.available - days,
      actor,
      requestId,
    });
  }

  async restoreWithLock(
    employeeId: string,
    locationId: string,
    days: number,
    requestId: string,
    actor: string,
  ): Promise<void> {
    let balance = await this.findOne(employeeId, locationId);
    let success = await this.tryUpdate(balance, days, 'restore');

    if (!success) {
      balance = await this.findOne(employeeId, locationId);
      success = await this.tryUpdate(balance, days, 'restore');
      if (!success) {
        throw new BalanceConflictException();
      }
    }

    await this.syncLogService.append({
      employeeId,
      locationId,
      source: SyncSource.REQUEST_CANCEL,
      previousAvailable: balance.available,
      newAvailable: balance.available + days,
      actor,
      requestId,
    });
  }

  private async tryUpdate(
    balance: Balance,
    days: number,
    operation: 'deduct' | 'restore',
  ): Promise<boolean> {
    const availDelta = operation === 'deduct' ? -days : days;
    const usedDelta = operation === 'deduct' ? days : -days;

    const result = await this.repo
      .createQueryBuilder()
      .update(Balance)
      .set({
        available: () => `available + ${availDelta}`,
        used: () => `used + ${usedDelta}`,
        version: () => 'version + 1',
      })
      .where(
        'employee_id = :eid AND location_id = :lid AND version = :v',
        { eid: balance.employeeId, lid: balance.locationId, v: balance.version },
      )
      .execute();

    return (result.affected ?? 0) > 0;
  }
}
