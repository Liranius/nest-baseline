import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BookingSchema1780000000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE EXTENSION IF NOT EXISTS btree_gist;
      CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL UNIQUE);
      CREATE TABLE accounts (
        id uuid PRIMARY KEY, login text NOT NULL UNIQUE, password_hash text NOT NULL,
        role text NOT NULL CHECK (role IN ('employee','admin')),
        organization_id uuid REFERENCES organizations(id),
        CHECK ((role = 'employee') = (organization_id IS NOT NULL))
      );
      CREATE TABLE equipment (id uuid PRIMARY KEY, name text NOT NULL UNIQUE);
      CREATE TABLE reservations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id uuid NOT NULL REFERENCES accounts(id),
        equipment_id uuid NOT NULL REFERENCES equipment(id),
        starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
        idempotency_key text NOT NULL,
        CHECK (starts_at < ends_at),
        UNIQUE (employee_id, idempotency_key),
        CONSTRAINT equipment_slot_exclusion EXCLUDE USING gist
          (equipment_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
          WHERE (status = 'confirmed')
      );
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE reservations, equipment, accounts, organizations');
  }
}
