import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { BookingSchema1780000000000 } from '../../dist/database/initial.migration.js';
import { EmployeeClient } from '../../clients/employee.mjs';
import { AdminClient } from '../../clients/admin.mjs';
import { withFixture, time } from './fixture.mjs';

const previous = {};
async function seedPreviousVersion({ url, sql, dbCommand }) {
  const db = await new DataSource({
    type: 'postgres',
    url,
    migrations: [BookingSchema1780000000000],
  }).initialize();
  try {
    assert.equal((await db.runMigrations()).length, 1);
  } finally {
    await db.destroy();
  }
  await dbCommand('seed');
  for (const status of ['confirmed', 'cancelled']) {
    const result = await sql.query(
      `INSERT INTO reservations(employee_id,equipment_id,starts_at,ends_at,idempotency_key,status)
      SELECT a.id,e.id,$1,$2,$3,$3 FROM accounts a CROSS JOIN equipment e
      WHERE a.login='employee-a' AND e.name='Microscope' RETURNING id`,
      [time(10), time(11), status],
    );
    previous[status] = result.rows[0].id;
  }
}
await test('upgrade from the stage 1 schema preserves historical reservations, replays and audit provenance', async () => {
  await withFixture(async ({ urls, env }) => {
    const a = new EmployeeClient(urls[0]),
      admin = new AdminClient(urls[1]);
    await a.login('employee-a', env.SEED_PASSWORD_A);
    await admin.login('lab-admin', env.SEED_PASSWORD_ADMIN);
    for (const [status, id] of Object.entries(previous)) {
      const booking = (await a.reservation(id)).body;
      assert.equal(booking.status, status);
      assert.deepEqual(await a.reserve(booking.equipmentId, booking.from, booking.to, status), {
        status: 201,
        body: { id },
      });
      const audit = (await admin.audit(id)).body;
      assert.equal(audit.coverage, 'from_migration');
      assert.equal(audit.reservationStatus, status);
      assert.deepEqual(audit.events, []);
    }
    assert.equal((await a.cancel(previous.confirmed)).status, 204);
    const audit = (await admin.audit(previous.confirmed)).body;
    assert.equal(audit.coverage, 'from_migration');
    assert.deepEqual(
      audit.events.map((e) => e.action),
      ['cancelled'],
    );
  }, seedPreviousVersion);
});
