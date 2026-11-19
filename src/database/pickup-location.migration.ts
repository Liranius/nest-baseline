import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PickupLocation1795200000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query("SET LOCAL lock_timeout = '350ms'");
    await q.query('ALTER TABLE reservations ADD COLUMN pickup_location varchar(120)');
  }
  async down(q: QueryRunner) {
    await q.query("SET LOCAL lock_timeout = '350ms'");
    await q.query('LOCK TABLE reservations IN ACCESS EXCLUSIVE MODE');
    const [used] = await q.query(
      'SELECT EXISTS(SELECT 1 FROM reservations WHERE pickup_location IS NOT NULL) AS used',
    );
    if (used.used)
      throw new Error(
        'Recorded pickup locations must be retained; roll back the application image.',
      );
    await q.query('ALTER TABLE reservations DROP COLUMN pickup_location');
  }
}
