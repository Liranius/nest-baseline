import test from 'node:test';
import assert from 'node:assert/strict';
import { loseSuccessfulResponse } from './lost-response.mjs';
import { EmployeeClient } from '../../clients/employee.mjs';
import { AdminClient } from '../../clients/admin.mjs';
import { withFixture, time } from './fixture.mjs';

await test('stage 1: two API processes enforce occupancy, replay and ownership through cancellation and rebooking', async () => {
  await withFixture(async ({ urls, sql, env }) => {
    const a = new EmployeeClient(urls[0]),
      b = new EmployeeClient(urls[1]),
      admin = new AdminClient(urls[0]);
    await a.login('employee-a', env.SEED_PASSWORD_A);
    await b.login('employee-b', env.SEED_PASSWORD_B);
    await admin.login('lab-admin', env.SEED_PASSWORD_ADMIN);
    const [device, otherDevice] = (await a.list()).body.map((row) => row.id);
    const window = { from: time(10), to: time(11) };
    for (const client of [a, b])
      assert.deepEqual((await client.availability(device, window.from, window.to)).body, [window]);
    const create = (client, key, id = device) => client.reserve(id, window.from, window.to, key);
    // Release both requests together only after both clients have observed the free interval.
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const attempts = [a, b].map((client) => gate.then(() => create(client, 'contest')));
    release();
    const results = await Promise.all(attempts);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const won = results.findIndex((r) => r.status === 201);
    const [winner, loser] = won === 0 ? [a, b] : [b, a];
    const id = results[won].body.id;
    assert.equal(results[1 - won].body.code, 'SLOT_CONFLICT');
    const count = async () =>
      Number(
        (
          await sql.query(
            "SELECT count(*) FROM reservations WHERE equipment_id=$1 AND status='confirmed' AND starts_at=$2",
            [device, window.from],
          )
        ).rows[0].count,
      );
    assert.equal(await count(), 1);
    for (const client of [a, b])
      assert.deepEqual((await client.availability(device, window.from, window.to)).body, []);
    assert.equal((await create(loser, 'overlap-key', device)).status, 409);
    assert.equal(
      (await loser.reserve(device, time(9), '2030-03-01T10:30:00Z', 'overlap')).body.code,
      'SLOT_CONFLICT',
    );
    assert.equal((await loser.reserve(device, time(11), time(12), 'adjacent')).status, 201);
    // The same key used by the winner is independently available to the other employee.
    assert.equal((await create(loser, 'contest', otherDevice)).status, 201);
    assert.deepEqual(
      await loser.reservation(id),
      await loser.reservation('99999999-9999-4999-9999-999999999999'),
    );
    assert.equal((await loser.reservation(id)).status, 404);
    assert.deepEqual(
      await loser.cancel(id),
      await loser.cancel('99999999-9999-4999-9999-999999999999'),
    );
    assert.equal((await loser.cancel(id)).status, 404);
    const denied = await admin.request('/reservations', {
      method: 'POST',
      body: { equipmentId: device, ...window },
      headers: { 'Idempotency-Key': 'admin' },
    });
    assert.equal(denied.status, 403);
    assert.equal((await admin.request('/reservations/' + id, { method: 'DELETE' })).status, 403);
    assert.equal((await winner.reservation(id)).body.status, 'confirmed');
    assert.equal((await winner.cancel(id)).status, 204);
    assert.equal((await winner.cancel(id)).status, 204);
    assert.equal(await count(), 0);
    const rebook = await create(loser, 'rebook-after-cancellation');
    assert.equal(rebook.status, 201);
    assert.notEqual(rebook.body.id, id);
    assert.deepEqual(await create(winner, 'contest'), results[won]);
    assert.equal((await winner.reservation(id)).body.status, 'cancelled');
    assert.equal(await count(), 1);
    assert.equal((await create(a, undefined)).status, 400);
    assert.equal(
      (await a.reserve('99999999-9999-4999-9999-999999999999', time(8), time(9), 'absent')).status,
      404,
    );
    const same = new EmployeeClient(urls[1]);
    same.token = a.token;
    const [first, replay] = await Promise.all([
      a.reserve(device, time(12), time(13), 'same-key'),
      same.reserve(device, '2030-03-01T20:00:00+08:00', time(13), 'same-key'),
    ]);
    assert.equal(first.status, 201);
    assert.deepEqual(replay, first);
    const changed = await a.reserve(device, time(12), time(14), 'same-key');
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await a.reservation(first.body.id)).body.to, time(13));
    const lostReceipt = await loseSuccessfulResponse(
      a,
      (client) => client.reserve(device, time(14), time(15), 'lost-response'),
      201,
    );
    const recovered = await same.reserve(device, time(14), time(15), 'lost-response');
    assert.equal(recovered.status, 201);
    assert.deepEqual(recovered.body, lostReceipt);
    for (const [key, receipt] of [
      ['same-key', first],
      ['lost-response', recovered],
    ]) {
      const rows = await sql.query('SELECT id FROM reservations WHERE idempotency_key=$1', [key]);
      assert.deepEqual(rows.rows, [receipt.body]);
    }
  });
});
