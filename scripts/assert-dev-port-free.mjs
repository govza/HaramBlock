// WXT silently drifts to the next port when 3000 is taken (usually by a
// zombie dev server left behind on Windows). The extension already loaded in
// the persistent dev profile keeps its old manifest CSP pinned to the previous
// port, which blocks every extension page script and leaves a stale service
// worker running old code — videos stay fail-closed blurred while the popup
// renders blank. Failing fast here turns that silent skew into a clear error.
// Escape hatch for intentionally running a second dev server: SKIP_DEV_PORT_CHECK=1.
import net from 'node:net';

const DEV_PORT = 3000;
// A holder may be bound to either loopback family; probe both.
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

if (process.env.SKIP_DEV_PORT_CHECK === '1') {
  process.exit(0);
}

function probe(host) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', error => {
      // An unavailable family (e.g. no IPv6) cannot hold the port.
      resolve(error.code === 'EADDRINUSE' ? 'taken' : 'free');
    });
    server.listen(DEV_PORT, host, () => {
      server.close(() => resolve('free'));
    });
  });
}

const results = await Promise.all(LOOPBACK_HOSTS.map(probe));
if (results.includes('taken')) {
  console.error(
    `\nPort ${DEV_PORT} is already in use — most likely a zombie dev server from a previous run.\n` +
      `Starting anyway would drift to another port and desync the loaded extension\n` +
      `(stale service worker, CSP-blocked popup). Kill the process holding ${DEV_PORT} first:\n\n` +
      `  PowerShell: Get-NetTCPConnection -LocalPort ${DEV_PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n` +
      `  POSIX:      kill $(lsof -ti :${DEV_PORT})\n\n` +
      `Or bypass with SKIP_DEV_PORT_CHECK=1 if the drift is intentional.\n`,
  );
  process.exit(1);
}
