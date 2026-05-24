import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum SyncSource {
  REALTIME_WEBHOOK = 'realtime_webhook',
  BATCH = 'batch',
  REQUEST_APPROVE = 'request_approve',
  REQUEST_CANCEL = 'request_cancel',
  INVALIDATION = 'invalidation',
}

@Entity('sync_log')
export class SyncLog {
  // TypeORM manages property assignment via reflection; `!` asserts definite assignment
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'employee_id' })
  employeeId!: string;

  @Column({ name: 'location_id' })
  locationId!: string;

  @Column({ type: 'simple-enum', enum: SyncSource })
  source!: SyncSource;

  @Column({ name: 'previous_available', type: 'float' })
  previousAvailable!: number;

  @Column({ name: 'new_available', type: 'float' })
  newAvailable!: number;

  @Column()
  actor!: string;

  @Column({ name: 'request_id', nullable: true, type: 'varchar' })
  requestId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
