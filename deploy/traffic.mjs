// This file runs inside the immutable stage 3 client image with its own OpenAPI validator.
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { EmployeeClient } from './clients/employee.mjs';
import { validateHttpContract } from './test/integration/contract.mjs';

validateHttpContract();
const validatedFetch = globalThis.fetch;
let observation;
globalThis.fetch = async (...args) => {
  const response = await validatedFetch(...args);
  observation = response.headers.get('x-booking-slot');
  return response;
};
const employee = new EmployeeClient('http://proxy:8080');
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
let next = performance.now();
async function call(action, expected, request, check = () => {}) {
  await wait(Math.max(0, next - performance.now()));
  const start = Date.now();
  next = performance.now() + 230;
  observation = null;
  try {
    const result = await request();
    assert.equal(result.status, expected);
    check(result.body);
    console.log(
      JSON.stringify({ start, end: Date.now(), action, slot: observation, status: result.status }),
    );
    return result.body;
  } catch (error) {
    console.log(
      JSON.stringify({ start, end: Date.now(), action, slot: observation, error: error.message }),
    );
    throw error;
  }
}
await call('login', 200, () => employee.login('employee-a', process.env.SEED_PASSWORD_A));
const [device] = await call('list', 200, () => employee.list());
for (let index = 0; !stopping; index++) {
  const from = new Date(Date.UTC(2040, 0, 1) + index * 60000).toISOString();
  const to = new Date(Date.parse(from) + 60000).toISOString();
  const key = 'traffic-' + index;
  const create = () => employee.reserve(device.id, from, to, key);
  const { id } = await call('create', 201, create);
  await call('replay', 201, create, (body) => assert.equal(body.id, id));
  await call(
    'read',
    200,
    () => employee.reservation(id),
    (body) => assert.equal(body.status, 'confirmed'),
  );
  await call(
    'conflict',
    409,
    () => employee.reserve(device.id, from, to, key + '-conflict'),
    (body) => assert.equal(body.code, 'SLOT_CONFLICT'),
  );
  await call('cancel', 204, () => employee.cancel(id));
}
