import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsNumber, IsString, ValidateNested } from 'class-validator';

export class BatchSyncRecordDto {
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @IsNumber()
  available!: number;

  @IsNumber()
  used!: number;

  @IsNumber()
  total!: number;
}

export class BatchSyncDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchSyncRecordDto)
  balances!: BatchSyncRecordDto[];
}
