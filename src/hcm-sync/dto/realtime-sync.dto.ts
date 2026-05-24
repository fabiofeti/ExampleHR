import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class RealtimeSyncDto {
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
