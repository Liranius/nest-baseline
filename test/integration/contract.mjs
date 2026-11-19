import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { mock } from 'node:test';

const document = JSON.parse(
  readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020();
addFormats(ajv);
const refRoot = 'urn:equipment:components';
const resolveRefs = (value) =>
  JSON.parse(JSON.stringify(value).replaceAll('#/components/schemas/', refRoot + '#/$defs/'));
ajv.addSchema({ $id: refRoot, $defs: resolveRefs(document.components.schemas) });
const routes = [];
for (const [template, methods] of Object.entries(document.paths)) {
  const pattern = new RegExp('^' + template.replaceAll('{id}', '[^/]+') + '$');
  for (const [method, operation] of Object.entries(methods)) {
    const responses = new Map();
    for (const [status, response] of Object.entries(operation.responses)) {
      const schema = response.content?.['application/json'].schema;
      responses.set(Number(status), schema ? ajv.compile(resolveRefs(schema)) : null);
    }
    routes.push({ method: method.toUpperCase(), pattern, responses });
  }
}

export function contractFor(method, path) {
  const route = routes.find((entry) => entry.method === method && entry.pattern.test(path));
  assert.ok(route, 'Undocumented request: ' + path);
  return (status) => {
    assert.ok(route.responses.has(status), 'Undocumented HTTP status: ' + status);
    return route.responses.get(status);
  };
}

export function validateHttpContract() {
  const original = globalThis.fetch;
  return mock.method(globalThis, 'fetch', async (url, options) => {
    const validatorFor = contractFor(options?.method ?? 'GET', new URL(url).pathname);
    const response = await original(url, options);
    const validate = validatorFor(response.status);
    const copy = response.clone();
    if (validate) {
      assert.match(copy.headers.get('content-type') ?? '', /application\/json/);
      assert.ok(validate(await copy.json()), ajv.errorsText(validate.errors));
    } else assert.equal(await copy.text(), '');
    return response;
  });
}
