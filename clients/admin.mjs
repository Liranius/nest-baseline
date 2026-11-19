import { BookingClient, loginFromEnv, printResult } from './http.mjs';
export class AdminClient extends BookingClient {
  checkout(id) {
    return this.request('/reservations/' + id + '/checkout', { method: 'PUT' });
  }
  receive(id) {
    return this.request('/reservations/' + id + '/return', { method: 'PUT' });
  }
  audit(id) {
    return this.request('/reservations/' + id + '/audit');
  }
  async inspect(from, to) {
    const catalog = await this.list();
    if (catalog.status !== 200) throw new Error('Unable to read equipment: ' + catalog.status);
    return Promise.all(
      catalog.body.map(async (equipment) => ({
        equipment,
        availability: await this.availability(equipment.id, from, to),
      })),
    );
  }
}

if (import.meta.main) {
  const client = new AdminClient(process.env.BOOKING_API_URL ?? 'http://127.0.0.1:3000');
  await loginFromEnv(client, 'lab-admin');
  const [action, ...args] = process.argv.slice(2);
  if (action === 'me') printResult(await client.me());
  else if (action === 'list') printResult(await client.list());
  else if (action === 'checkout') printResult(await client.checkout(...args));
  else if (action === 'return') printResult(await client.receive(...args));
  else if (action === 'handover') printResult(await client.handover(...args));
  else if (action === 'audit') printResult(await client.audit(...args));
  else if (action === 'inspect') {
    const devices = await client.inspect(...args);
    console.log(JSON.stringify(devices, null, 2));
    if (devices.some((device) => device.availability.status >= 400)) process.exitCode = 1;
  } else
    throw new Error(
      'Expected me, list, inspect FROM TO, handover ID, checkout ID, return ID or audit ID',
    );
}
