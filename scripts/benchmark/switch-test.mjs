/* Reproduces the model-switch regression: poker caches the device from session A,
   session A is released, session B gets a new device, pokes go to the dead queue. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { firefox } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const data = await readFile(path.join(ROOT, decodeURIComponent(url.pathname)));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(url.pathname)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await firefox.launch({
  headless: false,
  firefoxUserPrefs: { 'dom.webgpu.enabled': true },
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/scripts/benchmark/bench-page.html`);

const result = await page.evaluate(async () => {
  const ort = await import('/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs');
  ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;

  const opts = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 4 };

  const makeRun = (session, size, device) => async () => {
    const data = new Float32Array(3 * size * size).fill(0.5);
    const feeds = { images: new ort.Tensor('float32', data, [1, 3, size, size]) };
    let stop = false;
    const poke = () => {
      if (stop) return;
      device.queue.submit([]);
      setTimeout(poke, 0);
    };
    setTimeout(poke, 0);
    const t0 = performance.now();
    const out = await session.run(feeds);
    const ms = performance.now() - t0;
    stop = true;
    for (const k of Object.keys(out)) out[k]?.dispose();
    return ms;
  };

  const median = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];

  // Session A @ 320
  const sessionA = await ort.InferenceSession.create('/public/models/afeef-y26-sem-320-20260607/best.onnx', opts);
  const deviceA = await ort.env.webgpu.device;
  const runA = makeRun(sessionA, 320, deviceA);
  const aTimes = [];
  for (let i = 0; i < 8; i++) aTimes.push(await runA());
  await sessionA.release();

  // Session B @ 448 — poke with STALE device A (mimics the extension bug)
  const sessionB = await ort.InferenceSession.create('/public/models/afeef-y26-sem-448-20260607/best.onnx', opts);
  const deviceB = await ort.env.webgpu.device;
  const runStale = makeRun(sessionB, 448, deviceA);
  const staleTimes = [];
  for (let i = 0; i < 8; i++) staleTimes.push(await runStale());

  // Same session B — poke with FRESH device B (the fix)
  const runFresh = makeRun(sessionB, 448, deviceB);
  const freshTimes = [];
  for (let i = 0; i < 8; i++) freshTimes.push(await runFresh());
  await sessionB.release();

  return {
    sameDevice: deviceA === deviceB,
    medianA: median(aTimes.slice(2)),
    medianStale: median(staleTimes.slice(2)),
    medianFresh: median(freshTimes.slice(2)),
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
