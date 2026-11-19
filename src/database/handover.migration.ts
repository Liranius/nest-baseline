import type { MigrationInterface, QueryRunner } from 'typeorm';

export class EquipmentHandover1795000000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE FUNCTION booking_now() RETURNS timestamptz LANGUAGE sql VOLATILE
        AS 'SELECT date_trunc(''milliseconds'', clock_timestamp())';
      ALTER TABLE reservations ADD CONSTRAINT reservation_device UNIQUE (id, equipment_id);
      CREATE TABLE handovers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reservation_id uuid NOT NULL UNIQUE, equipment_id uuid NOT NULL,
        FOREIGN KEY (reservation_id, equipment_id) REFERENCES reservations(id, equipment_id),
        checked_out_at timestamptz NOT NULL, checked_out_by uuid NOT NULL REFERENCES accounts(id),
        returned_at timestamptz, returned_by uuid REFERENCES accounts(id),
        CHECK ((returned_at IS NULL) = (returned_by IS NULL)),
        CHECK (returned_at >= checked_out_at)
      );
      CREATE UNIQUE INDEX one_open_handover_per_device ON handovers(equipment_id) WHERE returned_at IS NULL;
      CREATE TABLE reservation_events (
        sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        reservation_id uuid NOT NULL REFERENCES reservations(id),
        actor_id uuid NOT NULL REFERENCES accounts(id), occurred_at timestamptz NOT NULL DEFAULT booking_now(),
        action text NOT NULL CHECK (action IN ('created','cancelled','checked_out','returned')),
        from_state text CHECK (from_state IN ('confirmed','checked_out')),
        to_state text NOT NULL CHECK (to_state IN ('confirmed','cancelled','checked_out','returned')),
        CHECK ((action = 'created') = (from_state IS NULL)),
        UNIQUE (reservation_id, action)
      );
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DROP TABLE reservation_events, handovers;
      ALTER TABLE reservations DROP CONSTRAINT reservation_device;
      DROP FUNCTION booking_now();
    `);
  }
}
