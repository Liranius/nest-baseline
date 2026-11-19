import assert from 'node:assert/strict';
import test from 'node:test';
import { EmployeeClient } from '../../clients/employee.mjs';
import { AdminClient } from '../../clients/admin.mjs';
import { withFixture } from './fixture.mjs';

await test('pickup location access and edits respect reservation ownership and physical handover', async () => {
  await withFixture(async ({ urls, env }) => {
    const owner = new EmployeeClient(urls[0]),
      other = new EmployeeClient(urls[1]),
      admin = new AdminClient(urls[1]);
    await owner.login('employee-a', env.SEED_PASSWORD_A);
    await other.login('employee-b', env.SEED_PASSWORD_B);
    await admin.login('lab-admin', env.SEED_PASSWORD_ADMIN);
    const [device, second] = (await owner.list()).body;
    const from = new Date(Date.now() - 60000).toISOString(),
      to = new Date(Date.now() + 600000).toISOString();
    const id = (await owner.reserve(device.id, from, to, 'desk')).body.id;
    const path = '/reservations/' + id + '/pickup-location';
    const put = (client, value) =>
      client.request(path, { method: 'PUT', body: { pickupLocation: value } });
    assert.deepEqual(await owner.request(path), { status: 200, body: { pickupLocation: null } });
    assert.equal((await other.request(path)).status, 404);
    assert.equal((await put(owner, 'Lab desk')).status, 403);
    assert.equal((await put(admin, '   ')).status, 400);
    assert.equal((await put(admin, 'X'.repeat(121))).status, 400);
    assert.deepEqual(await put(admin, ' Lab desk '), {
      status: 200,
      body: { pickupLocation: 'Lab desk' },
    });
    assert.deepEqual((await owner.request(path)).body, { pickupLocation: 'Lab desk' });
    assert.equal((await admin.checkout(id)).status, 200);
    assert.equal((await put(admin, 'Other')).body.code, 'PICKUP_LOCATION_LOCKED');
    assert.equal((await admin.receive(id)).status, 200);
    assert.equal((await put(admin, 'Other')).status, 409);
    const cancelled = (await owner.reserve(second.id, from, to, 'cancel-desk')).body.id;
    await owner.cancel(cancelled);
    assert.equal(
      (
        await admin.request('/reservations/' + cancelled + '/pickup-location', {
          method: 'PUT',
          body: { pickupLocation: 'Desk' },
        })
      ).status,
      409,
    );
  });
});
