import { IsOptional, IsString } from 'class-validator';

export class RejectTimeOffRequestDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
