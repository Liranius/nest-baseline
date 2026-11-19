// The recovery drill counts HTTP arrivals separately from the receiver's durable business effects.
import { createServer, request } from 'node:http';
for (const [company, listenPort, receiverPort] of [
  ['A', 46101, 46201],
  ['B', 46102, 46202],
]) {
  createServer((incoming, outgoing) => {
    const eventId = incoming.headers['webhook-id'];
    console.log(JSON.stringify({ company, eventId, phase: 'arrival' }));
    const forward = request(
      {
        hostname: '127.0.0.1',
        port: receiverPort,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
        timeout: 2500,
      },
      (reply) => {
        console.log(JSON.stringify({ company, eventId, phase: 'reply', status: reply.statusCode }));
        outgoing.writeHead(reply.statusCode, reply.headers);
        reply.on('error', () => outgoing.destroy());
        reply.pipe(outgoing);
      },
    );
    forward.on('timeout', () => forward.destroy());
    forward.on('error', () => {
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(503).end();
    });
    incoming.pipe(forward);
  }).listen(listenPort, '127.0.0.1');
}
