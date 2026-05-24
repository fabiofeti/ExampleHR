import { TimeOffRequest } from '../time-off-request.entity';

export class TimeOffRequestResponseDto {
  id!: string;
  employeeId!: string;
  locationId!: string;
  leaveType!: string;
  startDate!: string;
  endDate!: string;
  days!: number;
  status!: string;
  rejectionReason!: string | null;
  createdAt!: Date;
  updatedAt!: Date;

  static from(entity: TimeOffRequest): TimeOffRequestResponseDto {
    const dto = new TimeOffRequestResponseDto();
    dto.id = entity.id;
    dto.employeeId = entity.employeeId;
    dto.locationId = entity.locationId;
    dto.leaveType = entity.leaveType;
    dto.startDate = entity.startDate;
    dto.endDate = entity.endDate;
    dto.days = entity.days;
    dto.status = entity.status;
    dto.rejectionReason = entity.rejectionReason;
    dto.createdAt = entity.createdAt;
    dto.updatedAt = entity.updatedAt;
    return dto;
  }
}
