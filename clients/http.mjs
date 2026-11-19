export class BookingClient {
  constructor(baseUrl, transport) {
    this.baseUrl = baseUrl;
    this.transport = transport;
  }

  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await (this.transport ?? fetch)(new URL('/v1' + path, this.baseUrl), {
      method,
      headers: {
        ...(this.token && { authorization: 'Bearer ' + this.token }),
        ...(body && { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  async login(login, password) {
    this.token = undefined;
    const result = await this.request('/auth/login', { method: 'POST', body: { login, password } });
    if (result.status === 200) this.token = result.body.accessToken;
    return result;
  }
  handover(id) {
    return this.request('/reservations/' + id + '/handover');
  }
  me() {
    return this.request('/me');
  }
  list() {
    return this.request('/equipment');
  }
  availability(id, from, to) {
    return this.request('/equipment/' + id + '/availability?' + new URLSearchParams({ from, to }));
  }
}

export async function loginFromEnv(client, defaultLogin) {
  const password = process.env.BOOKING_PASSWORD;
  if (!password) throw new Error('Set BOOKING_PASSWORD for the selected account');
  const response = await client.login(process.env.BOOKING_LOGIN ?? defaultLogin, password);
  if (response.status !== 200) throw new Error('Login failed: HTTP ' + response.status);
}
export function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
  if (result.status >= 400) process.exitCode = 1;
}
