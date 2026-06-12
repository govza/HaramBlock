/**
 * Firefox WebGPU readback latency workaround.
 *
 * Firefox (wgpu) delivers buffer-map readbacks (`mapAsync`) on an internal ~100ms
 * device poll tick unless new work arrives on the queue. ONNX Runtime waits on such a
 * readback at the end of every `session.run()`, which pins Firefox WebGPU inference at
 * ~100ms per image regardless of model size.
 *
 * Submitting empty command buffers while a run is pending forces the device poll on
 * every event-loop turn, dropping inference latency to ~25-35ms (benchmarked via
 * `scripts/benchmark/run.mjs`). Chrome resolves readbacks promptly and never needs this.
 */

let pendingRuns = 0;

function pokeLoop(device: GPUDevice): void {
  if (pendingRuns === 0) return;
  device.queue.submit([]);
  setTimeout(() => pokeLoop(device), 0);
}

export async function runWithQueuePoke<T>(device: GPUDevice | undefined, run: () => Promise<T>): Promise<T> {
  if (!device) {
    return run();
  }

  pendingRuns++;
  if (pendingRuns === 1) {
    setTimeout(() => pokeLoop(device), 0);
  }

  try {
    return await run();
  } finally {
    pendingRuns--;
  }
}
