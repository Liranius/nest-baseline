import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EmployeeClient } from '../clients/employee.mjs';
import { contractFor } from '../test/integration/contract.mjs';
import { withFixture } from '../test/integration/fixture.mjs';

const { values } = parseArgs({
  options: { output: { type: 'string', default: '.tmp/contention.json' } },
});
const output = resolve(values.output);
const clientsPerRound = 16;
const warmupRounds = 5;
const measuredRounds = 50;
const firstSlot = Date.UTC(2042, 0, 1);
const validatorFor = contractFor('POST', '/v1/reservations');
// Use the real fetch. Validate the already-read response outside the latency measurement.
const networkFetch = globalThis.fetch;
const ms = (value) => Number(value.toFixed(3));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

async function loginClients(urls, env) {
  return Promise.all(
    Array.from({ length: clientsPerRound }, async (_, index) => {
      const company = index < 8 ? 'A' : 'B';
      const instance = index % 2;
      const actor = { clientNumber: index + 1, company, instance: instance + 1 };
      const api = new EmployeeClient(urls[instance], async (...args) => {
        const response = await networkFetch(...args);
        actor.status = response.status;
        actor.contentType = response.headers.get('content-type');
        return response;
      });
      const login = await api.login(
        'employee-' + company.toLowerCase(),
        env['SEED_PASSWORD_' + company],
      );
      if (login.status !== 200) throw Error('Client login failed: ' + login.status);
      return { actor, api };
    }),
  );
}

async function attempt({ actor, api }, device, round, from, to) {
  const { clientNumber, company, instance } = actor;
  actor.status = null;
  actor.contentType = null;
  const sample = { clientNumber, company, instance };
  const start = performance.now();
  let result;
  try {
    result = await api.reserve(device, from, to, 'contention-' + round + '-' + clientNumber);
  } catch (error) {
    let failure = 'connection';
    if (error.name === 'TimeoutError' || error.name === 'AbortError') failure = 'timeout';
    else if (error instanceof SyntaxError) failure = 'unreadable-response';
    return { ...sample, latencyMs: performance.now() - start, status: actor.status, failure };
  }
  const latencyMs = performance.now() - start;
  const { status, body } = result;
  const wrongConflictCode = status === 409 && body?.code !== 'SLOT_CONFLICT';
  try {
    const validate = validatorFor(status);
    if (!/^application\/json\b/i.test(actor.contentType ?? '') || !validate?.(body))
      throw Error('Response violates OpenAPI');
  } catch {
    return { ...sample, latencyMs, status, failure: 'contract', wrongConflictCode };
  }
  if (status === 201) return { ...sample, latencyMs, status, reservationId: body.id };
  if (status === 409 && body.code === 'SLOT_CONFLICT') return { ...sample, latencyMs, status };
  return {
    ...sample,
    latencyMs,
    status,
    failure: 'unexpected-result',
    code: body.code,
    wrongConflictCode,
  };
}

async function runRounds(clients, device, offset, count) {
  const rounds = [];
  const samples = [];
  const started = performance.now();
  for (let index = offset; index < offset + count; index++) {
    const from = new Date(firstSlot + index * 60000).toISOString();
    const to = new Date(firstSlot + (index + 1) * 60000).toISOString();
    const gate = Promise.withResolvers();
    const pending = clients.map((client) =>
      gate.promise.then(() => attempt(client, device, index, from, to)),
    );
    gate.resolve();
    const results = await Promise.all(pending);
    samples.push(...results);
    const winners = results.filter((row) => row.reservationId);
    const conflicts = results.filter((row) => row.status === 409 && !row.failure).length;
    const errors = results.filter((row) => row.failure);
    const winner = winners[0];
    rounds.push({
      round: index - offset + 1,
      from,
      to,
      successes: winners.length,
      expectedConflicts: conflicts,
      winner: winner
        ? {
            clientNumber: winner.clientNumber,
            company: winner.company,
            instance: winner.instance,
            reservationId: winner.reservationId,
          }
        : null,
      errors,
    });
  }
  return { rounds, samples, wallMs: performance.now() - started };
}

async function verifyRows(sql, device, rounds) {
  const result = await sql.query(
    `SELECT periods.n, r.id FROM
    unnest($2::timestamptz[], $3::timestamptz[]) WITH ORDINALITY AS periods(lo,hi,n)
    LEFT JOIN reservations r ON r.equipment_id=$1 AND r.status='confirmed'
      AND tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(periods.lo,periods.hi,'[)')
    ORDER BY periods.n, r.id`,
    [device, rounds.map((row) => row.from), rounds.map((row) => row.to)],
  );
  const ids = rounds.map(() => []);
  for (const row of result.rows) if (row.id) ids[Number(row.n) - 1].push(row.id);
  for (const [index, round] of rounds.entries()) {
    round.databaseIds = ids[index];
    round.passed =
      round.successes === 1 &&
      round.expectedConflicts === clientsPerRound - 1 &&
      round.errors.length === 0 &&
      ids[index].length === 1 &&
      ids[index][0] === round.winner?.reservationId;
  }
}

function summarize({ samples, rounds, wallMs }) {
  const times = samples.map((row) => row.latencyMs).sort((a, b) => a - b);
  const percentile = (percent) => ms(times[Math.ceil((times.length * percent) / 100) - 1]);
  return {
    requests: samples.length,
    wallMs: ms(wallMs),
    requestsPerSecond: ms((samples.length * 1000) / wallMs),
    latencyMs: {
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
      max: ms(times.at(-1)),
    },
    byInstance: [1, 2].map((instance) => ({
      instance,
      requests: samples.filter((row) => row.instance === instance).length,
      responses: samples.filter((row) => row.instance === instance && row.status !== null).length,
    })),
    successes: rounds.reduce((n, r) => n + r.successes, 0),
    expectedConflicts: rounds.reduce((n, r) => n + r.expectedConflicts, 0),
    timeouts: samples.filter((row) => row.failure === 'timeout').length,
    connectionsFailed: samples.filter((row) => row.failure === 'connection').length,
    http5xx: samples.filter((row) => row.status >= 500).length,
    contractErrors: samples.filter((row) =>
      ['contract', 'unreadable-response'].includes(row.failure),
    ).length,
    wrongConflictCodes: samples.filter((row) => row.wrongConflictCode).length,
    unexpectedErrors: samples.filter((row) => row.failure).length,
    unexpectedErrorRate: samples.filter((row) => row.failure).length / samples.length,
    rounds,
  };
}

const report = {
  startedUtc: new Date().toISOString(),
  passed: false,
  config: {
    clientsPerRound,
    warmupRounds,
    measuredRounds,
    companies: 2,
    clientsPerCompanyPerInstance: 4,
    apiProcesses: 2,
    requestTimeoutMs: 8000,
  },
};
try {
  report.environment = {
    revision: git('rev-parse', 'HEAD'),
    dirtyWorktree: git('status', '--porcelain') !== '',
    node: process.version,
    packageManager: process.env.npm_config_user_agent?.split(' ')[0],
    os: platform() + ' ' + release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
  };
  await withFixture(async ({ urls, env, sql }) => {
    report.environment.postgres = (await sql.query('SHOW server_version')).rows[0].server_version;
    const start = performance.now();
    const clients = await loginClients(urls, env);
    report.loginMs = ms(performance.now() - start);
    const device = (await clients[0].api.list()).body[0].id;
    report.equipmentId = device;
    const span = {
      from: new Date(firstSlot).toISOString(),
      to: new Date(firstSlot + (warmupRounds + measuredRounds) * 60000).toISOString(),
    };
    const free = await clients[0].api.availability(device, span.from, span.to);
    if (
      free.status !== 200 ||
      free.body.length !== 1 ||
      free.body[0].from !== span.from ||
      free.body[0].to !== span.to
    )
      throw Error('The measurement interval must begin entirely free');
    const warm = await runRounds(clients, device, 0, warmupRounds);
    const measured = await runRounds(clients, device, warmupRounds, measuredRounds);
    report.warmup = summarize(warm);
    report.measured = summarize(measured);
    const dbStart = performance.now();
    await verifyRows(sql, device, [...warm.rounds, ...measured.rounds]);
    report.databaseValidationMs = ms(performance.now() - dbStart);
    if (
      ![...warm.rounds, ...measured.rounds].every((round) => round.passed) ||
      !report.measured.byInstance.every((row) => row.responses === 400) ||
      report.measured.successes !== 50 ||
      report.measured.expectedConflicts !== 750
    )
      throw Error('Contention acceptance failed; inspect the round results');
  });
  report.passed = true;
} catch (error) {
  report.failure = error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database]');
  process.exitCode = 1;
} finally {
  report.finishedUtc = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(report.passed ? 'Contention accepted' : 'Contention failed', output);
}
