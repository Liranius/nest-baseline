import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('reservations')
export class Reservation {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' }) id!: string;
  @Column('uuid', { name: 'employee_id' }) employeeId!: string;
  @Column('uuid', { name: 'equipment_id' }) equipmentId!: string;
  @Column('timestamptz', { name: 'starts_at' }) from!: Date;
  @Column('timestamptz', { name: 'ends_at' }) to!: Date;
  @Column('text', { default: 'confirmed' }) status!: 'confirmed' | 'cancelled';
  @Column('text', { name: 'idempotency_key' }) idempotencyKey!: string;
  @Column('varchar', { name: 'pickup_location', length: 120, nullable: true })
  pickupLocation!: string | null;
}

export type ReservationDetails = Pick<Reservation, 'id' | 'equipmentId' | 'from' | 'to' | 'status'>;
