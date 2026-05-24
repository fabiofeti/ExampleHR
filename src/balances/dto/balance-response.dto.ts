import { Balance } from '../balance.entity';

export class BalanceResponseDto {
  employeeId!: string;
  locationId!: string;
  available!: number;
  used!: number;
  total!: number;
  version!: number;
  lastSyncedAt!: Date | null;

  static from(entity: Balance): BalanceResponseDto {
    const dto = new BalanceResponseDto();
    dto.employeeId = entity.employeeId;
    dto.locationId = entity.locationId;
    dto.available = entity.available;
    dto.used = entity.used;
    dto.total = entity.total;
    dto.version = entity.version;
    dto.lastSyncedAt = entity.lastSyncedAt;
    return dto;
  }
}
