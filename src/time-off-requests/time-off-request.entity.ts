import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum RequestStatus {
  PENDING     = 'PENDING',
  APPROVED    = 'APPROVED',
  REJECTED    = 'REJECTED',
  CANCELLED   = 'CANCELLED',
  INVALIDATED = 'INVALIDATED',
}

@Index(['employeeId', 'locationId', 'status'])
@Index(['startDate', 'endDate'])
@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'employee_id' })
  employeeId!: string;

  @Column({ name: 'location_id' })
  locationId!: string;

  @Column({ name: 'leave_type' })
  leaveType!: string;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate!: string;

  @Column({ type: 'float' })
  days!: number;

  @Column({ type: 'varchar' })
  status!: RequestStatus;

  @Column({ name: 'rejection_reason', nullable: true, type: 'varchar' })
  rejectionReason!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
