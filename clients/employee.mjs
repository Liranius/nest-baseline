import { BookingClient, loginFromEnv, printResult } from './http.mjs';
export class EmployeeClient extends BookingClient {
  reserve(equipmentId, from, to, key) {
    return this.request('/reservations', {
      method: 'POST',
      body: { equipmentId, from, to },
      headers: key ? { 'Idempotency-Key': key } : {},
    });
  }
  reservation(id) {
    return this.request('/reservations/' + id);
  }
  cancel(id) {
    return this.request('/reservations/' + id, { method: 'DELETE' });
  }
}

if (import.meta.main) {
  const client = new EmployeeClient(process.env.BOOKING_API_URL ?? 'http://127.0.0.1:3000');
  const [action, ...args] = process.argv.slice(2);
  await loginFromEnv(client, 'employee-a');
  switch (action) {
    case 'me':
      printResult(await client.me());
      break;
    case 'list':
      printResult(await client.list());
      break;
    case 'availability':
      printResult(await client.availability(...args));
      break;
    case 'reserve':
      printResult(await client.reserve(...args));
      break;
    case 'get':
      printResult(await client.reservation(...args));
      break;
    case 'cancel':
      printResult(await client.cancel(...args));
      break;
    default:
      throw new Error(
        'Expected me, list, availability ID FROM TO, reserve ID FROM TO KEY, get ID, or cancel ID',
      );
  }
}
