import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('equipment')
export class Equipment {
  @PrimaryColumn('uuid') id!: string;
  @Column('text') name!: string;
}

@Entity('accounts')
export class Account {
  @PrimaryColumn('uuid') id!: string;
  @Column('text') login!: string;
  @Column('text') role!: 'employee' | 'admin';
  @Column('uuid', { name: 'organization_id', nullable: true }) organizationId!: string | null;
  @Column('text', { name: 'password_hash', select: false }) passwordHash!: string;
}
