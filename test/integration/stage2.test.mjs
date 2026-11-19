import test from 'node:test';
import assert from 'node:assert/strict';
import { EmployeeClient } from '../../clients/employee.mjs';
import { AdminClient } from '../../clients/admin.mjs';
import { withFixture, time } from './fixture.mjs';
import { loseSuccessfulResponse } from './lost-response.mjs';

async function reserve(client, device, start, end, key) {
  const result = await client.reserve(device, time(start), time(end), key);
  assert.equal(result.status, 201);
  return result.body.id;
}
function rejected(result, status, code) {
  assert.equal(result.status, status);
  assert.equal(result.body.code, code);
}
async function together(...requests) {
  const gate = Promise.withResolvers();
  const pending = requests.map((send) => gate.promise.then(send));
  gate.resolve();
  return Promise.all(pending);
}
async function verifyStage2({ urls, sql, env }) {
  const a = new EmployeeClient(urls[0]),
    b = new EmployeeClient(urls[1]);
  const admin = new AdminClient(urls[0]),
    otherAdmin = new AdminClient(urls[1]);
  // An extra administrator exists only in this test, to detect a retry overwriting the original actor.
  await sql.query(`INSERT INTO accounts(id,login,password_hash,role)
    SELECT gen_random_uuid(),'second-admin',password_hash,role FROM accounts WHERE login='lab-admin'`);
  for (const [client, login, password] of [
    [a, 'employee-a', env.SEED_PASSWORD_A],
    [b, 'employee-b', env.SEED_PASSWORD_B],
    [admin, 'lab-admin', env.SEED_PASSWORD_ADMIN],
    [otherAdmin, 'second-admin', env.SEED_PASSWORD_ADMIN],
  ]) {
    assert.equal((await client.login(login, password)).status, 200);
  }
  const employeeId = (await a.me()).body.id;
  const firstAdminId = (await admin.me()).body.id;
  const secondAdminId = (await otherAdmin.me()).body.id;
  const [device, second] = (await a.list()).body.map((item) => item.id);
  // Only this disposable database has an adjustable clock. Both production API processes use it.
  await sql.query(`CREATE TABLE fixture_clock (at timestamptz NOT NULL);
    INSERT INTO fixture_clock VALUES ('2030-03-01T09:00:00Z');
    CREATE OR REPLACE FUNCTION booking_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS 'SELECT at FROM fixture_clock'`);
  const clock = (instant) => sql.query('UPDATE fixture_clock SET at=$1', [instant]);
  const aId = await reserve(a, device, 10, 11, 'first'),
    bId = await reserve(b, device, 11, 12, 'second');
  const otherId = await reserve(b, second, 10, 12, 'other-device');
  const stillPending = await reserve(a, second, 9, 10, 'expires');
  const cancelled = await reserve(a, second, 12, 13, 'cancel-me');
  assert.equal((await a.cancel(cancelled)).status, 204);
  assert.equal((await a.cancel(cancelled)).status, 204);
  assert.deepEqual(
    (await admin.audit(cancelled)).body.events.map((e) => [e.action, e.from, e.to, e.actorId]),
    [
      ['created', null, 'confirmed', employeeId],
      ['cancelled', 'confirmed', 'cancelled', employeeId],
    ],
  );
  assert.equal((await a.handover(cancelled)).body.state, 'cancelled');
  rejected(await admin.checkout(cancelled), 409, 'RESERVATION_CANCELLED');
  rejected(await new AdminClient(urls[0]).checkout(aId), 401, 'UNAUTHORIZED');
  for (const action of ['checkout', 'return'])
    rejected(
      await a.request('/reservations/' + aId + '/' + action, { method: 'PUT' }),
      403,
      'FORBIDDEN',
    );
  rejected(await a.request('/reservations/' + aId + '/audit'), 403, 'FORBIDDEN');
  assert.deepEqual(await b.handover(aId), await b.handover('99999999-9999-4999-9999-999999999999'));
  rejected(await b.handover(aId), 404, 'NOT_FOUND');
  assert.equal((await a.handover(aId)).body.state, 'pending');
  rejected(await admin.receive(aId), 409, 'NOT_CHECKED_OUT');
  rejected(await admin.checkout(aId), 409, 'OUTSIDE_PICKUP_WINDOW');
  await clock(time(10));
  rejected(await admin.checkout(stillPending), 409, 'OUTSIDE_PICKUP_WINDOW');
  const lost = await loseSuccessfulResponse(admin, (client) => client.checkout(aId), 200);
  const replay = await otherAdmin.checkout(aId);
  assert.deepEqual(replay, { status: 200, body: lost });
  assert.equal(lost.at, time(10));
  assert.equal(lost.actorId, firstAdminId);
  assert.equal((await a.handover(aId)).body.state, 'checked_out');
  rejected(await a.cancel(aId), 409, 'HANDOVER_EXISTS');
  // Race two different administrators on the other physical device.
  const [one, two] = await together(
    () => admin.checkout(otherId),
    () => otherAdmin.checkout(otherId),
  );
  assert.equal(one.status, 200);
  assert.deepEqual(one, two);
  assert.equal(
    (await admin.audit(otherId)).body.events.filter((e) => e.action === 'checked_out').length,
    1,
  );
  await clock('2030-03-01T11:05:00.000Z');
  rejected(await otherAdmin.checkout(bId), 409, 'EQUIPMENT_IN_USE');
  assert.equal(
    (
      await sql.query(
        'SELECT reservation_id FROM handovers WHERE equipment_id=$1 AND returned_at IS NULL',
        [device],
      )
    ).rows[0].reservation_id,
    aId,
  );
  assert.equal((await admin.audit(bId)).body.events.length, 1);
  const returned = await loseSuccessfulResponse(otherAdmin, (client) => client.receive(aId), 200);
  assert.equal(returned.handoverId, lost.handoverId);
  assert.equal(returned.actorId, secondAdminId);
  assert.equal(returned.at, '2030-03-01T11:05:00.000Z');
  assert.deepEqual((await admin.receive(aId)).body, returned);
  assert.deepEqual((await otherAdmin.checkout(aId)).body, lost);
  rejected(await a.cancel(aId), 409, 'HANDOVER_EXISTS');
  assert.equal((await a.handover(aId)).body.state, 'returned');
  assert.equal((await otherAdmin.checkout(bId)).status, 200);
  assert.deepEqual(
    (
      await sql.query(
        'SELECT reservation_id FROM handovers WHERE equipment_id=$1 AND returned_at IS NULL',
        [device],
      )
    ).rows,
    [{ reservation_id: bId }],
  );
  const audit = (await admin.audit(aId)).body;
  assert.equal(audit.coverage, 'complete');
  assert.equal(audit.equipmentId, device);
  assert.equal(audit.reservationId, aId);
  assert.deepEqual(audit.events, [
    { action: 'created', actorId: employeeId, at: time(9), from: null, to: 'confirmed' },
    {
      action: 'checked_out',
      actorId: firstAdminId,
      at: lost.at,
      from: 'confirmed',
      to: 'checked_out',
    },
    {
      action: 'returned',
      actorId: secondAdminId,
      at: returned.at,
      from: 'checked_out',
      to: 'returned',
    },
  ]);
  assert.equal((await a.handover(aId)).body.returned.actorId, secondAdminId);
  const [early, earlyReplay] = await together(
    () => admin.receive(otherId),
    () => otherAdmin.receive(otherId),
  );
  assert.equal(early.status, 200);
  assert.deepEqual(early, earlyReplay);
  assert.deepEqual((await b.availability(second, time(10), time(12))).body, []);
  rejected(
    await a.reserve(second, '2030-03-01T11:10:00Z', time(12), 'after-early-return'),
    409,
    'SLOT_CONFLICT',
  );

  await clock(time(13));
  const raceId = await reserve(a, second, 13, 14, 'cancel-vs-checkout');
  const [checkout, cancel] = await together(
    () => otherAdmin.checkout(raceId),
    () => a.cancel(raceId),
  );
  const actions = (await admin.audit(raceId)).body.events.map((e) => e.action);
  if (checkout.status === 200) {
    rejected(cancel, 409, 'HANDOVER_EXISTS');
    assert.deepEqual(actions, ['created', 'checked_out']);
  } else {
    rejected(checkout, 409, 'RESERVATION_CANCELLED');
    assert.equal(cancel.status, 204);
    assert.deepEqual(actions, ['created', 'cancelled']);
  }
  const count = (
    await sql.query('SELECT count(*)::int AS n FROM handovers WHERE reservation_id=$1', [raceId])
  ).rows[0].n;
  assert.equal(count, checkout.status === 200 ? 1 : 0);

  // A database rejection of the audit insert must also roll back the preceding physical mutation.
  const failId = await reserve(a, device, 13, 14, 'fault');
  await admin.receive(bId);
  await sql.query(
    "ALTER TABLE reservation_events ADD CONSTRAINT fixture_audit_failure CHECK (action <> 'checked_out') NOT VALID",
  );
  assert.equal((await admin.checkout(failId)).status, 500);
  assert.equal((await a.handover(failId)).body.state, 'pending');
  assert.deepEqual(
    (await admin.audit(failId)).body.events.map((e) => e.action),
    ['created'],
  );
  await sql.query('ALTER TABLE reservation_events DROP CONSTRAINT fixture_audit_failure');
  assert.equal((await admin.checkout(failId)).status, 200);
  await sql.query(
    "ALTER TABLE reservation_events ADD CONSTRAINT fixture_audit_failure CHECK (action <> 'returned') NOT VALID",
  );
  assert.equal((await admin.receive(failId)).status, 500);
  assert.equal((await a.handover(failId)).body.state, 'checked_out');
  assert.deepEqual(
    (await admin.audit(failId)).body.events.map((e) => e.action),
    ['created', 'checked_out'],
  );
  await sql.query('ALTER TABLE reservation_events DROP CONSTRAINT fixture_audit_failure');
  assert.equal((await admin.receive(failId)).status, 200);
}

await test('stage 2: real cross-instance handovers, overdue blocking, replay, permissions, atomic audit and cancellation race', async () => {
  await withFixture(verifyStage2);
});
