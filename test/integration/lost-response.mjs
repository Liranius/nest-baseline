import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

export async function loseSuccessfulResponse(client, send, expectedStatus) {
  // The proxy receives a committed response, then closes the downstream socket without forwarding it.
  let originalReceipt;
  let forwardingError;
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const result = await fetch(new URL(req.url, client.baseUrl), {
        method: req.method,
        headers: {
          authorization: req.headers.authorization,
          'content-type': 'application/json',
          ...(req.headers['idempotency-key'] && {
            'idempotency-key': req.headers['idempotency-key'],
          }),
        },
        body: Buffer.concat(chunks),
      });
      assert.equal(result.status, expectedStatus);
      originalReceipt = await result.json();
    } catch (error) {
      forwardingError = error;
    } finally {
      res.destroy();
    }
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    const downstream = new client.constructor('http://127.0.0.1:' + proxy.address().port);
    downstream.token = client.token;
    await assert.rejects(send(downstream), /fetch failed/);
    if (forwardingError) throw forwardingError;
    assert.ok(originalReceipt);
    return originalReceipt;
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
}
