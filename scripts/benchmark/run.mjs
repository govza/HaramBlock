import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, firefox } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.map': 'application/json',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.yaml': 'text/yaml',
};

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const match = args.find(a => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : fallback;
};

const browsers = getArg('browsers', 'chromium,firefox').split(',');
const sizes = getArg('sizes', '320,448,640').split(',').map(Number);
const batches = getArg('batch', '1')
  .split(',')
  .map(Number)
  .filter(n => Number.isFinite(n) && n >= 1);
const runs = Number(getArg('runs', '30'));
const warmups = Number(getArg('warmups', '5'));
const configFilter = getArg('configs', '');
// Substring matched against the model dir name - lets batch>1 target a dynamic-batch / ArgMax-head
// export (e.g. --variant=dynamic) without disturbing the default static-batch model selection.
const variant = getArg('variant', '');
const concurrency = Number(getArg('concurrency', '1'));
const verbose = args.includes('--verbose');

const CONFIGS = [
  { name: 'wasm', bundle: 'webgpu', backend: 'wasm' },
  { name: 'webgpu', bundle: 'webgpu', backend: 'webgpu' },
  { name: 'webgpu-gpuout', bundle: 'webgpu', backend: 'webgpu', outputLocation: 'gpu-buffer' },
  {
    name: 'webgpu-gc',
    bundle: 'webgpu',
    backend: 'webgpu',
    graphCapture: true,
    outputLocation: 'gpu-buffer',
    inputLocation: 'gpu',
  },
  { name: 'webgpu-jspi', bundle: 'jspi', backend: 'webgpu' },
  {
    name: 'webgpu-jspi-gc',
    bundle: 'jspi',
    backend: 'webgpu',
    graphCapture: true,
    outputLocation: 'gpu-buffer',
    inputLocation: 'gpu',
  },
  { name: 'webgpu-jsep', bundle: 'jsep', backend: 'webgpu' },
  { name: 'webgpu-jsep-gpuout', bundle: 'jsep', backend: 'webgpu', outputLocation: 'gpu-buffer' },
  {
    name: 'webgpu-jsep-gc',
    bundle: 'jsep',
    backend: 'webgpu',
    graphCapture: true,
    outputLocation: 'gpu-buffer',
    inputLocation: 'gpu',
  },
  { name: 'webgpu-nchw', bundle: 'webgpu', backend: 'webgpu', epOptions: { preferredLayout: 'NCHW' } },
  { name: 'webgpu-jsep-nchw', bundle: 'jsep', backend: 'webgpu', epOptions: { preferredLayout: 'NCHW' } },
  { name: 'webgpu-poke-t', bundle: 'webgpu', backend: 'webgpu', poker: 'timeout' },
  { name: 'webgpu-poke-c', bundle: 'webgpu', backend: 'webgpu', poker: 'channel' },
  { name: 'webgpu-poke-raf', bundle: 'webgpu', backend: 'webgpu', poker: 'raf' },
  { name: 'webgpu-jsep-poke-t', bundle: 'jsep', backend: 'webgpu', poker: 'timeout' },
  {
    name: 'webgpu-gpuout-poke-t',
    bundle: 'webgpu',
    backend: 'webgpu',
    outputLocation: 'gpu-buffer',
    poker: 'timeout',
  },
  {
    name: 'webgpu-jsep-gpuout-poke-t',
    bundle: 'jsep',
    backend: 'webgpu',
    outputLocation: 'gpu-buffer',
    poker: 'timeout',
  },
];

async function findModelDir(size, variantToken) {
  const entries = await readdir(path.join(ROOT, 'public', 'models'));
  const matches = entries.filter(e => e.includes(`-${size}-`));
  const dir = variantToken ? matches.find(e => e.includes(variantToken)) : matches[0];
  if (!dir) {
    throw new Error(`No model directory found for size ${size}${variantToken ? ` variant '${variantToken}'` : ''}`);
  }
  return dir;
}

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let filePath = path.join(ROOT, decodeURIComponent(url.pathname));
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
      }
      const data = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function launchBrowser(name) {
  if (name === 'chromium') {
    return chromium.launch({ headless: false });
  }
  if (name === 'firefox') {
    return firefox.launch({
      headless: false,
      firefoxUserPrefs: {
        'dom.webgpu.enabled': true,
        'dom.webgpu.workers.enabled': true,
        'javascript.options.wasm_js_promise_integration': true,
      },
    });
  }
  throw new Error(`Unknown browser: ${name}`);
}

const fmt = v => (typeof v === 'number' ? v.toFixed(1) : '—');

function fmtOutputs(outputs) {
  if (!outputs?.length) return '';
  return outputs.map(o => `${o.dtype}[${o.dims.join(',')}]@${o.location} ${(o.bytes / 1e6).toFixed(2)}MB`).join(' + ');
}

function printResults(browserName, results) {
  console.log(`\n## ${browserName}`);
  const adapter = results.find(r => r.adapter)?.adapter;
  if (adapter) console.log(`Adapter: ${adapter.vendor} ${adapter.architecture} ${adapter.description}`.trim());
  console.log(
    '| config | size | batch | session(ms) | warm1 | mean | median | run | readback | p90 | img(ms) | imgs/s |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.error) {
      const firstLine = r.error.split('\n')[0].slice(0, 100);
      console.log(`| ${r.name} | ${r.size} | ${r.batch ?? 1} | ERROR: ${firstLine} |`);
      continue;
    }
    console.log(
      `| ${r.name} | ${r.size} | ${r.batch ?? 1} | ${fmt(r.sessionCreateMs)} | ${fmt(r.warmupMs?.[0])} | ${fmt(
        r.stats?.mean,
      )} | ${fmt(r.stats?.median)} | ${fmt(r.stats?.runMean)} | ${fmt(r.stats?.readbackMean)} | ${fmt(
        r.stats?.p90,
      )} | ${fmt(r.stats?.perImageMean)} | ${fmt(r.stats?.effectiveThroughput)} |`,
    );
  }

  const withOutputs = results.filter(r => r.outputs?.length);
  if (withOutputs.length) {
    console.log('\nOutput tensors (first run):');
    for (const r of withOutputs) {
      console.log(`- ${r.name} @ ${r.size} x${r.batch ?? 1}: ${fmtOutputs(r.outputs)}`);
    }
  }
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/scripts/benchmark/bench-page.html`;
  console.log(`Server at ${pageUrl}`);

  const allResults = {};

  for (const browserName of browsers) {
    console.log(`\n=== ${browserName} ===`);
    const browser = await launchBrowser(browserName);
    const results = [];

    for (const size of sizes) {
      const model = await findModelDir(size, variant);
      for (const batch of batches) {
        for (const config of CONFIGS) {
          if (configFilter && !configFilter.split(',').includes(config.name)) continue;

          const page = await browser.newPage();
          if (verbose) {
            page.on('console', msg => console.log(`  [page] ${msg.text()}`));
            page.on('pageerror', err => console.log(`  [pageerror] ${err.message}`));
          }
          const label = `${config.name} @ ${size}${batch > 1 ? ` x${batch}` : ''}`;
          try {
            await page.goto(pageUrl);
            await page.waitForFunction(() => window.benchReady === true, undefined, { timeout: 30000 });
            const cfg = { ...config, size, batch, model, runs, warmupRuns: warmups, concurrency };
            console.log(`  running ${label}...`);
            const result = await page.evaluate(c => window.runBenchmark(c), cfg);
            if (result.error) {
              console.log(`    ERROR: ${result.error.split('\n')[0]}`);
            } else {
              console.log(
                `    session=${fmt(result.sessionCreateMs)}ms warm1=${fmt(result.warmupMs?.[0])}ms mean=${fmt(result.stats?.mean)}ms (run=${fmt(result.stats?.runMean)} readback=${fmt(result.stats?.readbackMean)}) img=${fmt(result.stats?.perImageMean)}ms eff=${fmt(result.stats?.effectiveThroughput)}/s`,
              );
            }
            results.push(result);
          } catch (error) {
            console.log(`    FAILED: ${String(error).split('\n')[0]}`);
            results.push({ name: config.name, size, batch, error: String(error) });
          } finally {
            await page.close();
          }
        }
      }
    }

    printResults(browserName, results);
    allResults[browserName] = results;
    await browser.close();
  }

  const outDir = path.join(ROOT, 'scripts', 'benchmark', 'results');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `bench-${stamp}.json`);
  await writeFile(outFile, JSON.stringify({ runs, warmups, batches, variant, results: allResults }, null, 2));
  console.log(`\nResults written to ${outFile}`);

  server.close();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
