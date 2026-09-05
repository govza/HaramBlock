// Brings up the local grafana/otel-lgtm stack (tools/otel/) so the dev build's OTLP export has
// somewhere to land. As a `pnpm dev` pre-step it never blocks: a missing Docker or a failed
// compose only prints a warning. `pnpm otel:up` runs it with --strict, where those become errors;
// `pnpm otel:down` runs it with --down to stop the stack through the same compose resolver.
// Skipped when WXT_OTEL_ENDPOINT='' (telemetry disabled anyway) or SKIP_OTEL_STACK=1.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECTOR_URL = 'http://localhost:4318/v1/traces';
const GRAFANA_URL = 'http://localhost:3001';
const DASHBOARD_URL = `${GRAFANA_URL}/d/haramblock-dvr`;
const WAIT_TIMEOUT_MS = 90_000;
const strict = process.argv.includes('--strict');
const down = process.argv.includes('--down');
const composeFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tools',
  'otel',
  'docker-compose.yml',
);

if (!down && (process.env.SKIP_OTEL_STACK === '1' || process.env.WXT_OTEL_ENDPOINT === '')) {
  process.exit(0);
}

const fail = message => {
  console.error(`\n[otel-lgtm] ${message}\n`);
  process.exit(strict ? 1 : 0);
};

async function collectorReady() {
  try {
    const response = await fetch(COLLECTOR_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

const shell = process.platform === 'win32';

function run(command, args) {
  return spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], shell });
}

function compose(args) {
  return spawnSync(composeCommand, [...composePrefix, '-f', composeFile, ...args], { stdio: 'inherit', shell });
}

function resolveCompose() {
  if (run('docker', ['compose', 'version']).status === 0) return ['docker', ['compose']];
  if (run('docker-compose', ['version']).status === 0) return ['docker-compose', []];
  return null;
}

if (!down && (await collectorReady())) {
  console.log(`[otel-lgtm] collector already up. Dashboard: ${DASHBOARD_URL}`);
  process.exit(0);
}

const daemon = run('docker', ['info']);
if (daemon.error || daemon.status !== 0) {
  fail('Docker is not available.');
}

const resolved = resolveCompose();
if (!resolved) {
  fail('Neither `docker compose` nor `docker-compose` found.');
}
const [composeCommand, composePrefix] = resolved;

if (down) {
  process.exit(compose(['down']).status ?? 1);
}

const up = run(composeCommand, [...composePrefix, '-f', composeFile, 'up', '-d', '--build']);
if (up.status !== 0) {
  fail(`compose up failed:\n${up.stderr}`);
}

process.stdout.write('[otel-lgtm] waiting for collector on 4318');
const deadline = Date.now() + WAIT_TIMEOUT_MS;
while (Date.now() < deadline) {
  if (await collectorReady()) {
    console.log(`\n[otel-lgtm] ready. Dashboard: ${DASHBOARD_URL} (anonymous admin)`);
    process.exit(0);
  }
  process.stdout.write('.');
  await new Promise(resolve => setTimeout(resolve, 2000));
}
fail(
  `collector not ready after ${WAIT_TIMEOUT_MS / 1000}s. Check: ${composeCommand} ${composePrefix.join(' ')} -f ${composeFile} logs`,
);
