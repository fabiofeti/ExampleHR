import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('balances')
export class Balance {
  // TypeORM manages property assignment via reflection; `!` asserts definite assignment
  @PrimaryColumn({ name: 'employee_id' })
  employeeId!: string;

  @PrimaryColumn({ name: 'location_id' })
  locationId!: string;

  @Column({ type: 'float' })
  available!: number;

  @Column({ type: 'float' })
  used!: number;

  @Column({ type: 'float' })
  total!: number;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @Column({ name: 'last_synced_at', type: 'datetime', nullable: true })
  lastSyncedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
