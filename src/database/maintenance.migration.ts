import type { MigrationInterface, QueryRunner } from 'typeorm';

export class MaintenanceWindows1795300000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`
      SET LOCAL lock_timeout = '350ms';
      CREATE TABLE maintenance_windows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        equipment_id uuid NOT NULL REFERENCES equipment(id),
        starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
        created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT booking_now(),
        cancelled_by uuid REFERENCES accounts(id), cancelled_at timestamptz,
        CHECK (starts_at < ends_at),
        CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
        CONSTRAINT maintenance_slot_exclusion EXCLUDE USING gist
          (equipment_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
          WHERE (cancelled_at IS NULL)
      );
      CREATE VIEW equipment_occupied_slots AS
        SELECT equipment_id, tstzrange(starts_at, ends_at, '[)') AS span, 'reservation'::text AS kind
          FROM reservations WHERE status = 'confirmed'
        UNION ALL
        SELECT equipment_id, tstzrange(starts_at, ends_at, '[)'), 'maintenance'::text
          FROM maintenance_windows WHERE cancelled_at IS NULL;

      -- Under READ COMMITTED the VOLATILE trigger reads a fresh snapshot after taking the device lock.
      CREATE FUNCTION check_other_slot_kind() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
      BEGIN
        PERFORM id FROM equipment WHERE id = NEW.equipment_id FOR NO KEY UPDATE;
        IF EXISTS (SELECT 1 FROM equipment_occupied_slots
                   WHERE equipment_id = NEW.equipment_id AND kind = TG_ARGV[0]
                     AND span && tstzrange(NEW.starts_at, NEW.ends_at, '[)')) THEN
          RAISE EXCEPTION 'Equipment time slot occupied'
            USING ERRCODE = '23P01', CONSTRAINT = 'equipment_slot_exclusion';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER check_maintenance_before_reservation
        BEFORE INSERT OR UPDATE OF equipment_id, starts_at, ends_at, status ON reservations
        FOR EACH ROW WHEN (NEW.status = 'confirmed') EXECUTE FUNCTION check_other_slot_kind('maintenance');
      CREATE TRIGGER check_reservation_before_maintenance
        BEFORE INSERT OR UPDATE OF equipment_id, starts_at, ends_at, cancelled_at ON maintenance_windows
        FOR EACH ROW WHEN (NEW.cancelled_at IS NULL) EXECUTE FUNCTION check_other_slot_kind('reservation');
    `);
  }

  async down(q: QueryRunner) {
    await q.query("SET LOCAL lock_timeout = '350ms'");
    await q.query('LOCK TABLE maintenance_windows IN ACCESS EXCLUSIVE MODE');
    const [records] = await q.query('SELECT EXISTS (SELECT FROM maintenance_windows) AS used');
    if (records.used) throw new Error('Maintenance history must be retained');
    await q.query(`
      DROP TRIGGER check_maintenance_before_reservation ON reservations;
      DROP TRIGGER check_reservation_before_maintenance ON maintenance_windows;
      DROP FUNCTION check_other_slot_kind();
      DROP VIEW equipment_occupied_slots;
      DROP TABLE maintenance_windows;
    `);
  }
}
