import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { DataSource } from 'typeorm';
import { BookingSchema1780000000000 } from '../../dist/database/initial.migration.js';
import { EquipmentHandover1795000000000 } from '../../dist/database/handover.migration.js';
import { EmployeeClient } from '../../clients/employee.mjs';
import { AdminClient } from '../../clients/admin.mjs';
import { withFixture, time, startProcess } from './fixture.mjs';

const directFetch = globalThis.fetch;
const exec = promisify(execFile);
async function until(read, accept, label) {
  const deadline = Date.now() + 40000;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for ' + label + ': ' + JSON.stringify(value));
}

async function runScenario({ urls, stopFirstApi, env, sql }) {
  const processes = [];
  let target,
    loseNext = false,
    lostId;
  const proxy = createServer((req, res) => {
    if (!target) {
      res.writeHead(500).end();
      return;
    }
    const upstream = request(
      new URL('/webhook', target),
      { method: req.method, headers: req.headers },
      (response) => {
        if (loseNext && response.statusCode === 204) {
          loseNext = false;
          lostId = req.headers['webhook-id'];
          response.resume();
          res.destroy();
          return;
        }
        res.writeHead(response.statusCode);
        response.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(500).end());
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const execute = (args, settings) =>
    exec(process.execPath, args, { env: settings, timeout: 20000 });
  const receiverEnv = (company) => ({
    ...env,
    RECEIVER_COMPANY: company,
    RECEIVER_DATABASE_URL: env.DATABASE_URL,
    RECEIVER_SECRET: env['WEBHOOK_SECRET_' + company],
  });
  async function launchReceiver(company) {
    const settings = receiverEnv(company);
    await execute(['dist/notifications/receiver.js', 'migrate'], settings);
    const child = await startProcess(
      settings,
      ['dist/notifications/receiver.js'],
      'Notification receiver ready:',
    );
    processes.push(child);
    return child;
  }
  const messages = [];
  async function launchWorker() {
    const child = await startProcess(
      env,
      ['dist/notifications/process.js', 'worker'],
      'Notification worker ready',
      (line) => {
        if (line.startsWith('{')) messages.push(JSON.parse(line));
      },
    );
    processes.push(child);
    return child;
  }
  try {
    const receiverB = await launchReceiver('B');
    const aFirst = await launchReceiver('A');
    target = aFirst.baseUrl;
    await execute(['dist/notifications/process.js', 'configure'], {
      ...env,
      WEBHOOK_URL_A: 'http://127.0.0.1:' + proxy.address().port + '/webhook',
      WEBHOOK_URL_B: receiverB.baseUrl + '/webhook',
    });
    const initialWorker = await launchWorker();
    await initialWorker.stop();
    // Stop the actual company A receiver. B stays up on its own endpoint.
    await aFirst.stop();
    const a = new EmployeeClient(urls[0]),
      b = new EmployeeClient(urls[1]),
      admin = new AdminClient(urls[1]);
    await a.login('employee-a', env.SEED_PASSWORD_A);
    await b.login('employee-b', env.SEED_PASSWORD_B);
    await admin.login('lab-admin', env.SEED_PASSWORD_ADMIN);
    const operator = (await admin.me()).body.id;
    const [one, two] = (await a.list()).body;
    const bookA = (client) => client.reserve(one.id, time(10), time(11), 'notify-a');
    const counts = async () =>
      (
        await sql.query(
          'SELECT (SELECT count(*) FROM reservations) r,(SELECT count(*) FROM reservation_events) audit,(SELECT count(*) FROM notification_events) events,(SELECT count(*) FROM nest_outbox.messages) outbox',
        )
      ).rows[0];
    const before = await counts();
    await sql.query(`CREATE FUNCTION abort_commit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture commit failure'; END$$;
      CREATE CONSTRAINT TRIGGER fixture_abort AFTER INSERT ON notification_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION abort_commit()`);
    assert.equal((await bookA(a)).status, 500);
    assert.deepEqual(await counts(), before);
    await sql.query('DROP TRIGGER fixture_abort ON notification_events');
    const receipt = await bookA(a);
    assert.equal(receipt.status, 201);
    const aId = receipt.body.id;
    assert.deepEqual(await bookA(a), receipt);
    const fromAdmin = async (id) => {
      const response = await admin.notifications(id);
      assert.equal(response.status, 200);
      return response.body;
    };
    const [queued] = await fromAdmin(aId);
    assert.equal(queued.status, 'queued');
    // Terminate the producer after commit and before starting a replacement worker.
    await stopFirstApi();
    a.baseUrl = urls[1];
    const bId = (await b.reserve(two.id, time(10), time(11), 'notify-b')).body.id;
    assert.equal((await a.request('/reservations/' + aId + '/notifications')).status, 403);
    await launchWorker();
    await until(
      () => fromAdmin(bId),
      (rows) => rows[0].status === 'succeeded',
      'company B delivery during A outage',
    );
    const [failed] = await until(
      () => fromAdmin(aId),
      (rows) => rows[0].status === 'failed',
      'company A retry exhaustion',
    );
    assert.equal(failed.failureReason, 'exhausted');
    assert.equal(failed.attempts, 5);
    assert.equal(failed.history.length, 5);
    assert.ok(failed.lastError);
    assert.equal(failed.nextAttemptAt, null);
    assert.ok(messages.some((m) => m.eventId === queued.eventId));
    await until(
      async () => messages,
      (m) => m.some((e) => e.kind === 'notification_metrics' && e.exhausted >= 1),
      'worker metrics for exhausted delivery',
    );
    target = (await launchReceiver('A')).baseUrl;
    const invalid = await directFetch(new URL('/webhook', target), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': randomUUID(),
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,' + Buffer.alloc(32).toString('base64'),
      },
      body: '{}',
    });
    assert.equal(invalid.status, 401);
    assert.equal((await sql.query('SELECT id FROM company_a_receiver.inbox')).rowCount, 0);
    loseNext = true;
    assert.equal((await a.cancel(aId)).status, 204);
    assert.equal((await a.cancel(aId)).status, 204);
    const [, cancelled] = await until(
      () => fromAdmin(aId),
      (rows) => rows[1]?.status === 'succeeded',
      'cancellation after dropped acknowledgement',
    );
    assert.equal(cancelled.eventId, lostId);
    assert.equal(cancelled.attempts, 2);
    const projection = async () =>
      (
        await sql.query(
          'SELECT version,status FROM company_a_receiver.reservations WHERE reservation_id=$1',
          [aId],
        )
      ).rows;
    assert.deepEqual(await projection(), [{ version: 2, status: 'cancelled' }]);
    assert.equal(
      (await sql.query('SELECT id FROM company_a_receiver.inbox WHERE id=$1', [lostId])).rowCount,
      1,
    );
    const path = '/notification-deliveries/' + failed.deliveryId + '/replay';
    assert.equal((await a.request(path, { method: 'POST' })).status, 403);
    const replay = await Promise.all([
      admin.replay(failed.deliveryId),
      admin.replay(failed.deliveryId),
    ]);
    assert.deepEqual(
      replay.map((r) => r.status).sort((left, right) => left - right),
      [202, 409],
    );
    const [delivered] = await until(
      () => fromAdmin(aId),
      (rows) => rows[0].status === 'succeeded',
      'late confirmation replay',
    );
    assert.equal(delivered.eventId, queued.eventId);
    assert.equal(delivered.history.length, 6);
    assert.deepEqual(delivered.history.slice(0, 5), failed.history);
    assert.equal(delivered.replays.length, 1);
    assert.equal(delivered.replays[0].actorId, operator);
    assert.equal((await admin.replay(failed.deliveryId)).body.code, 'DELIVERY_NOT_EXHAUSTED');
    assert.deepEqual(await projection(), [{ version: 2, status: 'cancelled' }]);
    assert.deepEqual(
      (
        await sql.query(
          'SELECT reservation_id,version FROM company_a_receiver.inbox ORDER BY version',
        )
      ).rows,
      [
        { reservation_id: aId, version: 1 },
        { reservation_id: aId, version: 2 },
      ],
    );
    assert.deepEqual(
      (await sql.query('SELECT reservation_id,version FROM company_b_receiver.inbox')).rows,
      [{ reservation_id: bId, version: 1 }],
    );
    const cli = await execute(['clients/admin.mjs', 'notifications', aId], {
      ...env,
      BOOKING_API_URL: urls[1],
      BOOKING_LOGIN: 'lab-admin',
      BOOKING_PASSWORD: env.SEED_PASSWORD_ADMIN,
    });
    assert.deepEqual(JSON.parse(cli.stdout).body, await fromAdmin(aId));
    assert.equal((await fromAdmin(aId)).length, 2);
  } finally {
    try {
      await Promise.all(processes.map((p) => p.stop()));
    } finally {
      await new Promise((resolve) => proxy.close(resolve));
    }
  }
}
await test('stage 3: signed HTTP, commit recovery, tenant isolation, lost acknowledgement and out-of-order replay', async () => {
  await withFixture(runScenario);
});

await test('stage 2 upgrade starts notifications at the next transition', async () => {
  let oldId;
  await withFixture(
    async ({ urls, env, sql }) => {
      const employee = new EmployeeClient(urls[0]),
        admin = new AdminClient(urls[1]);
      await employee.login('employee-a', env.SEED_PASSWORD_A);
      await admin.login('lab-admin', env.SEED_PASSWORD_ADMIN);
      assert.deepEqual((await admin.notifications(oldId)).body, []);
      assert.equal((await employee.cancel(oldId)).status, 204);
      const events = (await admin.notifications(oldId)).body;
      assert.deepEqual(
        events.map((e) => [e.version, e.status]),
        [[2, 'queued']],
      );
      assert.equal((await sql.query('SELECT id FROM nest_outbox.messages')).rowCount, 1);
    },
    async ({ url, sql, dbCommand }) => {
      const db = await new DataSource({
        type: 'postgres',
        url,
        migrations: [BookingSchema1780000000000, EquipmentHandover1795000000000],
      }).initialize();
      try {
        await db.runMigrations();
      } finally {
        await db.destroy();
      }
      await dbCommand('seed');
      const result = await sql.query(
        `INSERT INTO reservations(employee_id,equipment_id,starts_at,ends_at,idempotency_key)
      SELECT a.id,e.id,$1,$2,'legacy' FROM accounts a CROSS JOIN equipment e WHERE a.login='employee-a' AND e.name='Microscope' RETURNING id`,
        [time(10), time(11)],
      );
      oldId = result.rows[0].id;
      await sql.query(
        `INSERT INTO reservation_events(reservation_id,actor_id,action,from_state,to_state)
      SELECT id,employee_id,'created',NULL,'confirmed' FROM reservations WHERE id=$1`,
        [oldId],
      );
    },
  );
});
