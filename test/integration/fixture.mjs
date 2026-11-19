import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { Client } from 'pg';
import { validateHttpContract } from './contract.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const randomSecret = () => randomBytes(32).toString('hex');

export async function startProcess(
  env,
  args = ['dist/main.js'],
  prefix = 'Booking API ready:',
  onLine = () => {},
) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...env, PORT: env.PORT ?? '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const closed = once(child, 'exit');
  let diagnostic = '';
  child.stderr.on('data', (data) => {
    diagnostic = (diagnostic + data).slice(-1500);
  });
  const lines = createInterface({ input: child.stdout });
  let timer;
  try {
    const baseUrl = await new Promise((accept, reject) => {
      timer = setTimeout(() => reject(new Error('API startup timed out. ' + diagnostic)), 15000);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error('API exited ' + code + '. ' + diagnostic)));
      lines.on('line', (line) => {
        onLine(line);
        if (line.startsWith(prefix)) {
          const value = line.slice(prefix.length).trim();
          accept(value ? 'http://127.0.0.1:' + new URL(value).port : undefined);
        }
      });
    });
    return {
      baseUrl,
      stop: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      },
    };
  } catch (error) {
    child.kill();
    await closed;
    throw error;
  } finally {
    clearTimeout(timer);
    // readline continues draining output and closes when the child exits.
  }
}

// Each invocation creates and owns a new database; never migrate or clear the supplied database.
export async function withFixture(run, preparePreviousVersion) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; see README');
  const endpoint = new URL(process.env.TEST_DATABASE_URL);
  if (!endpoint.pathname.endsWith('_test')) throw new Error('Use a dedicated *_test database');
  const control = new Client({ connectionString: endpoint.href, connectionTimeoutMillis: 5000 });
  const name = 'booking_run_' + randomUUID().replaceAll('-', '');
  const apis = [];
  let created = false;
  let sql;
  await control.connect();
  try {
    await control.query('CREATE DATABASE ' + name);
    created = true;
    endpoint.pathname = '/' + name;
    const env = {
      ...process.env,
      PORT: '0',
      DATABASE_URL: endpoint.href,
      NOTIFICATION_ENCRYPTION_KEY: randomSecret(),
      NOTIFICATIONS_LOCAL: '1',
      WEBHOOK_URL_A: 'http://127.0.0.1:46101/webhook',
      WEBHOOK_URL_B: 'http://127.0.0.1:46102/webhook',
      WEBHOOK_SECRET_A: 'whsec_' + randomBytes(32).toString('base64'),
      WEBHOOK_SECRET_B: 'whsec_' + randomBytes(32).toString('base64'),
      JWT_SECRET: randomSecret(),
      SEED_PASSWORD_A: randomSecret(),
      SEED_PASSWORD_B: randomSecret(),
      SEED_PASSWORD_ADMIN: randomSecret(),
    };
    const dbCommand = (action) =>
      exec(process.execPath, ['dist/database/command.js', action], {
        cwd: root,
        env,
        timeout: 30000,
      });
    sql = new Client({ connectionString: endpoint.href });
    await sql.connect();
    if (preparePreviousVersion)
      await preparePreviousVersion({ url: endpoint.href, sql, dbCommand });
    const previousCount = preparePreviousVersion
      ? (await sql.query('SELECT count(*)::int AS n FROM migrations')).rows[0].n
      : 0;
    assert.match(
      (await dbCommand('migrate')).stdout,
      preparePreviousVersion
        ? new RegExp('applied: ' + (4 - previousCount) + '$', 'm')
        : /applied: 4/,
    );
    assert.match((await dbCommand('migrate')).stdout, /applied: 0/);
    await dbCommand('seed');
    await dbCommand('seed');
    await exec(process.execPath, ['dist/notifications/process.js', 'configure'], {
      cwd: root,
      env,
    });
    apis.push(await startProcess(env));
    apis.push(await startProcess(env));
    const contract = validateHttpContract();
    try {
      await run({ urls: apis.map((api) => api.baseUrl), stopFirstApi: apis[0].stop, sql, env });
    } finally {
      contract.mock.restore();
    }
  } finally {
    try {
      await Promise.all(apis.map((api) => api.stop()));
    } finally {
      try {
        if (sql) await sql.end();
        if (created) await control.query('DROP DATABASE ' + name + ' WITH (FORCE)');
      } finally {
        await control.end();
      }
    }
  }
}

// A correctly signed expired token isolates the expiry check from the signature check.
export function expiredToken(secret, sub) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const content =
    encode({ alg: 'HS256', typ: 'JWT' }) +
    '.' +
    encode({ sub, iss: 'equipment-booking-api', aud: 'booking-client', exp: 1 });
  return content + '.' + createHmac('sha256', secret).update(content).digest('base64url');
}
export const day = '2030-03-01';
export const time = (hour) => day + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z';
