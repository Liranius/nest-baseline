import test from 'node:test';
import assert from 'node:assert/strict';
import { withFixture, expiredToken, time } from './fixture.mjs';
import { EmployeeClient } from '../../clients/employee.mjs';
import { AdminClient } from '../../clients/admin.mjs';

await test('stage 0: clean migration, repeatable seeds, identity and availability over HTTP', async () => {
  await withFixture(async ({ urls, sql, env }) => {
    const a = new EmployeeClient(urls[0]),
      b = new EmployeeClient(urls[1]),
      admin = new AdminClient(urls[1]);
    const counts = await sql.query(
      'SELECT (SELECT count(*)::int FROM accounts) AS accounts,(SELECT count(*)::int FROM organizations) AS orgs,(SELECT count(*)::int FROM equipment) AS devices',
    );
    assert.deepEqual(counts.rows[0], { accounts: 3, orgs: 2, devices: 2 });
    assert.equal((await a.list()).status, 401);
    assert.equal((await a.login('employee-a', 'wrong-password')).status, 401);
    assert.equal((await a.login('employee-a', env.SEED_PASSWORD_A)).body.expiresIn, 900);
    assert.equal((await b.login('employee-b', env.SEED_PASSWORD_B)).status, 200);
    assert.equal((await admin.login('lab-admin', env.SEED_PASSWORD_ADMIN)).status, 200);
    const claims = JSON.parse(Buffer.from(a.token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(claims.exp - claims.iat, 900);
    const me = (await a.me()).body;
    assert.equal(me.role, 'employee');
    assert.equal(me.login, 'employee-a');
    assert.notEqual((await b.me()).body.organizationId, me.organizationId);
    assert.equal((await admin.me()).body.role, 'admin');
    assert.equal((await admin.me()).body.organizationId, null);
    const other = new EmployeeClient(urls[1]);
    other.token = a.token;
    assert.deepEqual((await other.me()).body, me);
    other.token = expiredToken(env.JWT_SECRET, me.id);
    assert.equal((await other.me()).status, 401);
    const devices = (await a.list()).body;
    assert.equal(devices.length, 2);
    const id = devices[0].id;
    const initial = await admin.inspect(time(9), time(12));
    assert.deepEqual(initial[0].availability.body, [{ from: time(9), to: time(12) }]);
    await sql.query(
      'INSERT INTO reservations(employee_id,equipment_id,starts_at,ends_at,idempotency_key) VALUES($1,$2,$3,$4,$5)',
      [me.id, id, time(10), time(11), 'fixture-occupied'],
    );
    const expected = [
      { from: time(9), to: time(10) },
      { from: time(11), to: time(12) },
    ];
    assert.deepEqual((await b.availability(id, time(9), time(12))).body, expected);
    assert.deepEqual(
      (await a.availability(id, '2030-03-01T17:00:00+08:00', time(12))).body,
      expected,
    );
    assert.deepEqual((await b.availability(id, time(10), time(11))).body, []);
    for (const [from, to] of [
      ['2030-03-01T09:00:00', time(12)],
      [time(11), time(11)],
      [time(12), time(9)],
      ['2030-02-30T09:00:00Z', time(12)],
    ]) {
      assert.equal((await a.availability(id, from, to)).status, 400);
    }
    assert.equal(
      (await a.availability('99999999-9999-4999-8999-999999999999', time(9), time(12))).status,
      404,
    );
  });
});
