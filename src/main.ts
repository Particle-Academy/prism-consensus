/**
 * Entry point.
 *
 * Binds to 127.0.0.1 only. The room holds a human's credential in a cookie and
 * drives real agents on this machine; exposing it on 0.0.0.0 would be a
 * different product with a different threat model, and the Genie site layer is
 * what gives it an origin.
 */
import { createConsensusServer } from './server.js';

const port = Number(process.env.PORT ?? 8099);
const app = createConsensusServer({ port, cwd: process.cwd() });

const bound = await app.listen(port);
process.stdout.write(`consensus room listening on http://127.0.0.1:${String(bound)}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
