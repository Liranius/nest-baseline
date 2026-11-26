import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { BookingSchema1780000000000 } from '../../dist/database/initial.migration.js';
import { EquipmentHandover1795000000000 } from '../../dist/database/handover.migration.js';
import { BookingNotifications1795100000000 } from '../../dist/database/notifications.migration.js';
import { PickupLocation1795200000000 } from '../../dist/database/pickup-location.migration.js';
import { AdminClient } from '../../clients/admin.mjs';
import { EmployeeClient } from '../../clients/employee.mjs';
import { time, withFixture } from './fixture.mjs';

const absent = '99999999-9999-4999-9999-999999999999';
function conflict(result) {
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SLOT_CONFLICT');
}
function created(result) {
  assert.equal(result.status, 201);
  return result.body.id;
}

await test('maintenance lifecycle, cross-company availability, authorization and idempotent history', async () => {
  await withFixture(async ({ urls, env }) => {
    const admin = new AdminClient(urls[0]),
      a = new EmployeeClient(urls[0]),
      b = new EmployeeClient(urls[1]);
    await admin.login('lab-admin', env.SEED_PASSWORD_ADMIN);
    await a.login('employee-a', env.SEED_PASSWORD_A);
    await b.login('employee-b', env.SEED_PASSWORD_B);
    const [device, other] = (await a.list()).body.map((row) => row.id);
    const path = '/equipment/' + device + '/maintenance-windows';
    const adminId = (await admin.me()).body.id;
    const get = async () => (await admin.maintenanceWindows(device, time(8), time(14))).body;
    assert.equal(
      (await a.request(path, { method: 'POST', body: { from: time(10), to: time(11) } })).status,
      403,
    );
    assert.equal(
      (await b.request(path + '?' + new URLSearchParams({ from: time(8), to: time(14) }))).status,
      403,
    );
    assert.equal((await admin.scheduleMaintenance(absent, time(10), time(11))).status, 404);
    assert.equal((await admin.maintenanceWindows(absent, time(10), time(11))).status, 404);
    assert.equal((await admin.cancelMaintenance(absent)).status, 404);
    assert.equal(
      (await admin.scheduleMaintenance(device, time(10).slice(0, -1), time(11))).status,
      400,
    );
    assert.equal((await admin.maintenanceWindows(device, time(12), time(11))).status, 400);
    const old = created(await a.reserve(device, time(10), time(11), 'original'));
    conflict(await admin.scheduleMaintenance(device, time(9), time(11)));
    assert.equal((await a.cancel(old)).status, 204);
    const windowId = created(
      await admin.scheduleMaintenance(device, '2030-03-01T18:00:00+08:00', time(11)),
    );
    assert.equal(
      (await b.request('/maintenance-windows/' + windowId, { method: 'DELETE' })).status,
      403,
    );
    assert.deepEqual(await a.reserve(device, time(10), time(11), 'original'), {
      status: 201,
      body: { id: old },
    });
    assert.equal((await a.reservation(old)).body.status, 'cancelled');
    conflict(await b.reserve(device, time(10), time(11), 'blocked'));
    conflict(await admin.scheduleMaintenance(device, time(10), time(12)));
    const [active] = await get();
    assert.deepEqual(active, {
      id: windowId,
      equipmentId: device,
      from: time(10),
      to: time(11),
      status: 'scheduled',
      createdBy: adminId,
      createdAt: active.createdAt,
      cancelledBy: null,
      cancelledAt: null,
    });
    for (const client of [a, b]) {
      assert.deepEqual((await client.availability(device, time(9), time(12))).body, [
        { from: time(9), to: time(10) },
        { from: time(11), to: time(12) },
      ]);
    }
    created(await b.reserve(device, time(11), time(12), 'adjacent'));
    created(await admin.scheduleMaintenance(device, time(9), time(10)));
    created(await admin.scheduleMaintenance(other, time(10), time(11)));
    assert.equal((await admin.cancelMaintenance(windowId)).status, 204);
    const cancelled = (await get()).find((row) => row.id === windowId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelledBy, adminId);
    assert.ok(cancelled.cancelledAt);
    assert.equal((await admin.cancelMaintenance(windowId)).status, 204);
    assert.deepEqual(
      (await get()).find((row) => row.id === windowId),
      cancelled,
    );
    assert.deepEqual((await b.availability(device, time(10), time(11))).body, [
      { from: time(10), to: time(11) },
    ]);
    created(await b.reserve(device, time(10), time(11), 'blocked'));
    const moved = created(await admin.scheduleMaintenance(device, time(12), time(13)));
    assert.notEqual(moved, windowId);
    assert.deepEqual(
      (await get()).map((row) => row.from),
      [time(9), time(10), time(12)],
    );
  });
});

await test('two API processes race a maintenance window against a reservation or another window', async () => {
  await withFixture(async ({ urls, env, sql }) => {
    const employee = new EmployeeClient(urls[0]),
      first = new AdminClient(urls[0]),
      second = new AdminClient(urls[1]);
    await employee.login('employee-a', env.SEED_PASSWORD_A);
    await Promise.all(
      [first, second].map((client) => client.login('lab-admin', env.SEED_PASSWORD_ADMIN)),
    );
    const device = (await employee.list()).body[0].id;
    for (const [index, maintenanceOnly] of [false, true].entries()) {
      const from = time(10 + index),
        to = time(11 + index);
      const gate = Promise.withResolvers();
      const contenders = [
        gate.promise.then(() =>
          maintenanceOnly
            ? first.scheduleMaintenance(device, from, to)
            : employee.reserve(device, from, to, 'race'),
        ),
        gate.promise.then(() => second.scheduleMaintenance(device, from, to)),
      ];
      await sql.query('BEGIN');
      try {
        await sql.query('SELECT id FROM equipment WHERE id=$1 FOR NO KEY UPDATE', [device]);
        gate.resolve();
        // Both independent server sessions must be queued on a database lock before releasing it.
        const deadline = performance.now() + 4000;
        for (;;) {
          await sql.query('SELECT pg_stat_clear_snapshot()');
          const {
            rows: [{ waiters }],
          } = await sql.query(
            "SELECT count(*)::int AS waiters FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0",
          );
          if (waiters >= 2) break;
          assert.ok(performance.now() < deadline, 'Both API requests should reach the device lock');
          await delay(20);
        }
      } finally {
        await sql.query('ROLLBACK');
      }
      const results = await Promise.all(contenders);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      conflict(results.find((r) => r.status === 409));
      const { rows } = await sql.query(
        `SELECT id FROM reservations WHERE equipment_id=$1 AND status='confirmed' AND starts_at=$2
        UNION ALL SELECT id FROM maintenance_windows WHERE equipment_id=$1 AND cancelled_at IS NULL AND starts_at=$2`,
        [device, from],
      );
      assert.deepEqual(rows, [results.find((r) => r.status === 201).body]);
    }
    const migration = 'MaintenanceWindows1795300000000';
    await sql.query('UPDATE migrations SET name=$2 WHERE name=$1', [
      migration,
      'temporarily-missing',
    ]);
    assert.equal((await fetch(urls[0] + '/health/ready')).status, 503);
    assert.equal((await fetch(urls[0] + '/', { method: 'HEAD' })).status, 503);
    await sql.query('UPDATE migrations SET name=$1 WHERE name=$2', [
      migration,
      'temporarily-missing',
    ]);
    assert.equal((await fetch(urls[1] + '/health/ready')).status, 200);
    assert.equal((await fetch(urls[1] + '/', { method: 'HEAD' })).status, 200);
  });
});

await test('upgrade from the 3309044 schema keeps bookings, handovers, audit and replay receipts', async () => {
  const adminId = '10000000-0000-4000-8000-000000000003';
  let original;
  async function history(sql) {
    const tables = ['reservations', 'handovers', 'reservation_events'];
    const records = [];
    for (const table of tables)
      records.push((await sql.query('SELECT * FROM ' + table + ' ORDER BY 1')).rows);
    return records;
  }
  await withFixture(
    async ({ urls, env, sql }) => {
      assert.deepEqual(await history(sql), original);
      const employee = new EmployeeClient(urls[1]),
        admin = new AdminClient(urls[0]);
      await employee.login('employee-a', env.SEED_PASSWORD_A);
      await admin.login('lab-admin', env.SEED_PASSWORD_ADMIN);
      const booking = original[0][0];
      assert.equal(
        created(await employee.reserve(booking.equipment_id, time(10), time(11), 'existing')),
        booking.id,
      );
      assert.equal((await employee.handover(booking.id)).body.state, 'checked_out');
      assert.deepEqual(
        (await admin.audit(booking.id)).body.events.map((event) => event.action),
        ['created', 'checked_out'],
      );
      conflict(await admin.scheduleMaintenance(booking.equipment_id, time(10), time(11)));
      created(await admin.scheduleMaintenance(booking.equipment_id, time(11), time(12)));
      assert.deepEqual(
        (await employee.availability(booking.equipment_id, time(10), time(12))).body,
        [],
      );
    },
    async ({ url, sql, dbCommand }) => {
      const old = await new DataSource({
        type: 'postgres',
        url,
        migrations: [
          BookingSchema1780000000000,
          EquipmentHandover1795000000000,
          BookingNotifications1795100000000,
          PickupLocation1795200000000,
        ],
      }).initialize();
      try {
        assert.equal((await old.runMigrations()).length, 4);
      } finally {
        await old.destroy();
      }
      await dbCommand('seed');
      const {
        rows: [booking],
      } = await sql.query(
        `INSERT INTO reservations(employee_id,equipment_id,starts_at,ends_at,idempotency_key,status,pickup_location)
      SELECT a.id,e.id,$1,$2,'existing','confirmed','Desk' FROM accounts a CROSS JOIN equipment e
      WHERE a.login='employee-a' AND e.name='Microscope' RETURNING *`,
        [time(10), time(11)],
      );
      await sql.query(
        'INSERT INTO handovers(reservation_id,equipment_id,checked_out_at,checked_out_by) VALUES($1,$2,$3,$4)',
        [booking.id, booking.equipment_id, time(10), adminId],
      );
      await sql.query(
        `INSERT INTO reservation_events(reservation_id,actor_id,occurred_at,action,from_state,to_state) VALUES
      ($1,$2,$4,'created',NULL,'confirmed'),($1,$3,$5,'checked_out','confirmed','checked_out')`,
        [booking.id, booking.employee_id, adminId, time(9), time(10)],
      );
      original = await history(sql);
    },
  );
});
