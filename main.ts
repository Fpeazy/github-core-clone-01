// github-core-clone-01 — process entrypoint.
//
// One job only: bring the forge from app.ts up on a kernel-chosen port,
// tell the contest suite where it lives, then stay alive serving requests
// until the suite reports that it is finished. Nothing else happens here:
// all of the git / REST / GraphQL / MCP behaviour lives in app.ts.
//
// Wire contract (kit RULES.txt, "The suite and the wire"):
//   1. bind an ephemeral port (port 0; never 8080, where the suite listens)
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}
//   4. exit 0. Anything that fails before step 3 completes exits non-zero.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

// Where the suite lives, and the two routes it serves for entries.
const SUITE_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const REGISTER_ROUTE = '/register';
const DONE_ROUTE = '/done';

// Polling / retry tuning. The suite gives an entry a 20 s boot budget, so
// registration retries stay short and the done-poll stays cheap.
const REGISTER_TIMEOUT_MS = 5_000;
const REGISTER_ATTEMPTS = 5;
const REGISTER_RETRY_MS = 500;
const DONE_POLL_MS = 500;
const DONE_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2_000;

function die(message: string, cause?: unknown): never {
  const detail = cause instanceof Error ? `: ${cause.message}` : '';
  console.error(`[forge] fatal: ${message}${detail}`);
  process.exit(1);
}

function suiteUrl(route: string): string {
  if (SUITE_ORIGIN === '') {
    die('MAKEFUN_ENV_URL is not set; the suite has no address to register with');
  }
  let origin: URL;
  try {
    origin = new URL(SUITE_ORIGIN);
  } catch {
    die(`MAKEFUN_ENV_URL is not a valid URL: ${SUITE_ORIGIN}`);
  }
  return `${origin.origin}${route}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolve with the port the kernel picked once the forge is listening.
function bindEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('forge listener has no TCP address after listen'));
        return;
      }
      resolve(address.port);
    });
  });
}

// POST {"port": n} to the suite. A 200 with {ok: true} means the suite has
// recorded this entry; 409 means another entry already registered, which is
// fatal for this process. Transient network failures are retried briefly.
async function announcePort(port: number): Promise<void> {
  const url = suiteUrl(REGISTER_ROUTE);
  let lastError: unknown;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
      if (response.status === 409) {
        die('suite refused registration: another entry already registered (409)');
      }
      if (!response.ok) {
        throw new Error(`registration answered HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (
        typeof payload !== 'object' ||
        payload === null ||
        (payload as { ok?: unknown }).ok !== true
      ) {
        throw new Error(`registration answered an unexpected body: ${JSON.stringify(payload)}`);
      }
      console.log(`[forge] registered with suite at ${url} on port ${port}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < REGISTER_ATTEMPTS) await sleep(REGISTER_RETRY_MS);
    }
  }
  die(`could not register with the suite after ${REGISTER_ATTEMPTS} attempts`, lastError);
}

// GET /done in a loop until the suite answers {"done": true}. A failed poll
// (suite briefly unreachable, bad JSON) is treated as "not done yet" and
// retried; only a clean {"done": true} ends the wait.
async function awaitSuiteFinished(): Promise<void> {
  const url = suiteUrl(DONE_ROUTE);
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(DONE_TIMEOUT_MS) });
      if (response.ok) {
        const payload: unknown = await response.json();
        if (
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true
        ) {
          console.log('[forge] suite reports done; shutting down');
          return;
        }
      }
    } catch {
      // Transient: the suite may not be reachable for a moment. Keep polling.
    }
    await sleep(DONE_POLL_MS);
  }
}

// Close the listener, dropping any idle keep-alive connections first so the
// process does not linger on them, and give the close a short deadline.
async function stopServing(server: Server): Promise<void> {
  server.closeAllConnections?.();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.race([closed, sleep(SHUTDOWN_GRACE_MS)]);
}

async function run(): Promise<void> {
  // Fail fast on a missing suite address before binding anything.
  suiteUrl(REGISTER_ROUTE);

  const server = createApp();

  // A signal means "stop now": close the forge, then leave with the
  // conventional signal exit code. The exit must be forced here, not just
  // recorded via exitCode: while the done-poll below is awaiting, nothing
  // else would ever end the process, so a bare exitCode would hang us
  // until the trial wall instead of stopping promptly.
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals, code: number): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[forge] received ${signal}; shutting down`);
    void stopServing(server).finally(() => {
      process.exit(code);
    });
  };
  process.once('SIGINT', () => onSignal('SIGINT', 130));
  process.once('SIGTERM', () => onSignal('SIGTERM', 143));
  server.on('error', (error) => die('forge listener failed', error));

  const port = await bindEphemeral(server);
  console.log(`[forge] listening on port ${port}`);
  await announcePort(port);
  await awaitSuiteFinished();
  await stopServing(server);
}

run().catch((error: unknown) => die('forge entrypoint failed', error));
