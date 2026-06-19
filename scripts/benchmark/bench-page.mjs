const ORT_DIST = '/node_modules/onnxruntime-web/dist/';

const BUNDLE_URLS = {
  webgpu: `${ORT_DIST}ort.webgpu.bundle.min.mjs`, // native WebGPU EP + asyncify
  jspi: `${ORT_DIST}ort.jspi.bundle.min.mjs`, // native WebGPU EP + JSPI
  jsep: `${ORT_DIST}ort.bundle.min.mjs`, // JSEP (JS-based WebGPU EP)
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const computeStats = runsMs => {
  const sorted = [...runsMs].sort((a, b) => a - b);
  const mean = runsMs.reduce((a, b) => a + b, 0) / runsMs.length;
  return {
    mean,
    median: percentile(sorted, 50),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p90: percentile(sorted, 90),
    throughput: 1000 / mean,
  };
};

async function getAdapterInfo() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const info = adapter.info ?? {};
    return {
      vendor: info.vendor ?? '',
      architecture: info.architecture ?? '',
      device: info.device ?? '',
      description: info.description ?? '',
    };
  } catch {
    return null;
  }
}

window.runBenchmark = async cfg => {
  const result = {
    name: cfg.name,
    size: cfg.size,
    batch: cfg.batch ?? 1,
    jspiSupported: typeof WebAssembly.Suspending === 'function',
    webgpuAvailable: 'gpu' in navigator,
  };

  let session = null;
  let gpuBuffer = null;

  try {
    if (cfg.bundle === 'jspi' && !result.jspiSupported) {
      throw new Error('JSPI not supported in this browser');
    }
    if (cfg.backend === 'webgpu' && !result.webgpuAvailable) {
      throw new Error('WebGPU API not available');
    }

    result.adapter = await getAdapterInfo();

    const ort = await import(BUNDLE_URLS[cfg.bundle]);
    ort.env.wasm.wasmPaths = ORT_DIST;
    // Match extension service worker constraints: single-threaded, no proxy worker
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'warning';
    if (cfg.powerPreference) {
      ort.env.webgpu.powerPreference = cfg.powerPreference;
    }

    const size = cfg.size;
    const batch = cfg.batch ?? 1;
    const dims = [batch, 3, size, size];
    const elemCount = batch * 3 * size * size;

    const sessionOptions = {
      executionProviders: [cfg.epOptions ? { name: cfg.backend, ...cfg.epOptions } : cfg.backend],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 4,
    };
    if (cfg.graphCapture) sessionOptions.enableGraphCapture = true;
    if (cfg.outputLocation) sessionOptions.preferredOutputLocation = cfg.outputLocation;

    const modelUrl = `/public/models/${cfg.model}/best.onnx`;

    const tCreate = performance.now();
    session = await ort.InferenceSession.create(modelUrl, sessionOptions);
    result.sessionCreateMs = performance.now() - tCreate;

    const inputName = session.inputNames[0];

    const cpuData = new Float32Array(elemCount);
    for (let i = 0; i < elemCount; i++) cpuData[i] = Math.random();

    let inputTensor = null;
    let device = null;

    let pokerStop = () => {};
    if (cfg.poker) {
      const pokeDevice = ort.env.webgpu?.device;
      if (!pokeDevice) throw new Error('ort.env.webgpu.device unavailable, cannot start poker');
      let stopped = false;
      pokerStop = () => {
        stopped = true;
      };
      const poke = () => {
        if (stopped) return;
        pokeDevice.queue.submit([]);
        schedule();
      };
      let schedule;
      if (cfg.poker === 'raf') {
        schedule = () => requestAnimationFrame(poke);
      } else if (cfg.poker === 'channel') {
        const mc = new MessageChannel();
        mc.port1.onmessage = poke;
        schedule = () => mc.port2.postMessage(0);
      } else {
        schedule = () => setTimeout(poke, 0);
      }
      schedule();
    }

    if (cfg.inputLocation === 'gpu') {
      device = ort.env.webgpu?.device;
      if (!device) throw new Error('ort.env.webgpu.device unavailable, cannot create GPU input tensor');
      gpuBuffer = device.createBuffer({
        size: cpuData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
      inputTensor = ort.Tensor.fromGpuBuffer(gpuBuffer, { dataType: 'float32', dims });
    }

    let checksum = 0;
    let outputMeta = null;

    const runOnce = async () => {
      const t0 = performance.now();
      let feeds;
      if (gpuBuffer) {
        // Upload new frame data into the persistent GPU buffer (counted in timing, like a real frame)
        device.queue.writeBuffer(gpuBuffer, 0, cpuData);
        feeds = { [inputName]: inputTensor };
      } else {
        feeds = { [inputName]: new ort.Tensor('float32', cpuData, dims) };
      }

      const outputs = await session.run(feeds);
      const tRun = performance.now();

      const meta = [];
      for (const key of Object.keys(outputs)) {
        const tensor = outputs[key];
        const data = tensor.location === 'cpu' ? tensor.data : await tensor.getData();
        checksum += Number(data[0]) + Number(data[data.length - 1]);
        // Output shape/dtype/bytes reveal whether an ArgMax head shrank the readback and
        // whether it stayed on the WebGPU EP (a CPU-EP fallback shows up as a larger readback).
        meta.push({
          name: key,
          location: tensor.location,
          dtype: tensor.type,
          dims: tensor.dims,
          bytes: data.byteLength ?? data.length * (data.BYTES_PER_ELEMENT ?? 4),
        });
        if (!cfg.graphCapture) tensor.dispose?.();
      }
      if (!outputMeta) outputMeta = meta;

      const tEnd = performance.now();
      return { total: tEnd - t0, run: tRun - t0, readback: tEnd - tRun };
    };

    const warmupRuns = cfg.warmupRuns ?? 3;
    const warmupMs = [];
    for (let i = 0; i < warmupRuns; i++) {
      warmupMs.push((await runOnce()).total);
    }
    result.warmupMs = warmupMs;

    const runs = cfg.runs ?? 20;
    const concurrency = cfg.concurrency ?? 1;
    const samples = [];
    const tWall = performance.now();
    if (concurrency === 1) {
      for (let i = 0; i < runs; i++) {
        samples.push(await runOnce());
      }
    } else {
      let started = 0;
      const worker = async () => {
        while (started < runs) {
          started++;
          samples.push(await runOnce());
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
    }
    result.wallMs = performance.now() - tWall;
    result.runsMs = samples.map(s => s.total);
    result.stats = computeStats(result.runsMs);
    result.stats.runMean = samples.reduce((a, s) => a + s.run, 0) / samples.length;
    result.stats.readbackMean = samples.reduce((a, s) => a + s.readback, 0) / samples.length;
    // Per-image figures so batched runs compare directly against batch 1.
    result.stats.perImageMean = result.stats.mean / batch;
    result.stats.effectiveThroughput = (runs * batch * 1000) / result.wallMs;
    result.outputs = outputMeta;
    result.checksum = checksum;
    pokerStop();
  } catch (error) {
    result.error = String(error?.stack ?? error);
  } finally {
    try {
      await session?.release();
    } catch {
      /* ignore */
    }
    try {
      gpuBuffer?.destroy();
    } catch {
      /* ignore */
    }
  }

  return result;
};

window.benchReady = true;
