#!/usr/bin/env node
/**
 * End-to-end check of the built decoders through the dec_* C interface.
 * Usage: node scripts/wasm-decoders/verify.mjs [wasmDir]  (needs ffmpeg + ffprobe with libvpx-vp9, libaom-av1 on PATH)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const wasmDir = resolve(process.argv[2] ?? join(repoRoot, 'public/wasm-decoders'));
const mediaDir = mkdtempSync(join(tmpdir(), 'wasm-decoders-verify-'));
const WIDTH = 320;
const HEIGHT = 180;

/** The emitted glue is a classic UMD script, which a `"type": "module"` package cannot `require`. */
const loadClassicModule = file => {
  const module = { exports: {} };
  const load = new Function('module', 'exports', 'require', '__filename', '__dirname', readFileSync(file, 'utf8'));
  load(module, module.exports, createRequire(file), file, dirname(file));
  return module.exports;
};

const run = (tool, args) => execFileSync(tool, args, { cwd: mediaDir, encoding: 'utf8' });

const encode = (output, codecArgs, extraArgs = []) =>
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${WIDTH}x${HEIGHT}:rate=25:duration=2`,
    '-pix_fmt',
    'yuv420p',
    ...codecArgs,
    '-g',
    '25',
    ...extraArgs,
    output,
  ]);

const probePackets = file =>
  run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts,size,pos',
    '-of',
    'json',
    file,
  ]).match(/\{[\s\S]*\}/u)[0];

const readIvf = file => {
  const bytes = readFileSync(join(mediaDir, file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = view.getUint32(16, true);
  const scale = view.getUint32(20, true);
  const packets = [];
  for (let offset = view.getUint16(6, true); offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset, true);
    const pts = Number(view.getBigUint64(offset + 4, true));
    packets.push({
      data: bytes.subarray(offset + 12, offset + 12 + size),
      ptsUs: Math.round((pts * scale * 1e6) / rate),
    });
    offset += 12 + size;
  }
  return packets;
};

const findBoxPayload = (bytes, fourcc) => {
  const tag = Buffer.from(fourcc, 'latin1');
  const at = bytes.indexOf(tag);
  const size = bytes.readUInt32BE(at - 4);
  return bytes.subarray(at + 4, at - 4 + size);
};

const mp4TimeBase = file => {
  const [num, den] = run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=time_base',
    '-of',
    'csv=p=0',
    file,
  ])
    .trim()
    .split('/')
    .map(Number);
  return num / den;
};

const mp4Stream = (file, configBox) => {
  const bytes = readFileSync(join(mediaDir, file));
  const timeBase = mp4TimeBase(file);
  const samples = JSON.parse(probePackets(file)).packets;
  return {
    extradata: findBoxPayload(bytes, configBox),
    packets: samples.map(s => ({
      data: bytes.subarray(Number(s.pos), Number(s.pos) + Number(s.size)),
      ptsUs: Math.round(Number(s.pts) * timeBase * 1e6),
    })),
  };
};

const toHeap = (mod, bytes) => {
  const ptr = mod._malloc(Math.max(bytes.length, 1));
  mod.HEAPU8.set(bytes, ptr);
  return ptr;
};

const readCurrentFrame = mod => {
  const width = mod._dec_width();
  const height = mod._dec_height();
  const stride = mod._dec_stride(0);
  const plane = mod._dec_plane(0);
  const hash = createHash('sha1');
  let lumaSum = 0;
  for (let y = 0; y < height; y++) {
    const row = mod.HEAPU8.subarray(plane + y * stride, plane + y * stride + width);
    hash.update(row);
    for (const value of row) lumaSum += value;
  }
  return {
    ptsUs: mod._dec_pts(),
    width,
    height,
    format: mod._dec_format(),
    lumaMean: lumaSum / (width * height),
    hash: hash.digest('hex'),
  };
};

const receiveAll = (mod, frames) => {
  for (;;) {
    const r = mod._dec_receive();
    if (r < 0) throw new Error(`dec_receive failed: ${r}`);
    if (r === 0) return;
    frames.push(readCurrentFrame(mod));
  }
};

const decodeRun = (mod, packets, interleaved) => {
  const frames = [];
  for (const packet of packets) {
    const r = mod._dec_send(toHeap(mod, packet.data), packet.data.length, packet.ptsUs);
    if (r < 0) throw new Error(`dec_send failed: ${r}`);
    if (interleaved) receiveAll(mod, frames);
  }
  const r = mod._dec_drain();
  if (r < 0) throw new Error(`dec_drain failed: ${r}`);
  receiveAll(mod, frames);
  return frames;
};

const checkRun = (label, packets, frames) => {
  const problems = [];
  if (frames.length !== packets.length) problems.push(`${frames.length} frames for ${packets.length} packets`);
  const expected = packets
    .map(p => p.ptsUs)
    .sort((a, b) => a - b)
    .join();
  const actual = frames
    .map(f => f.ptsUs)
    .sort((a, b) => a - b)
    .join();
  if (expected !== actual) problems.push('output pts set differs from input pts set');
  if (frames.some(f => f.width !== WIDTH || f.height !== HEIGHT)) problems.push('wrong frame size');
  if (frames.some(f => f.format !== 0)) problems.push('non-I420 format');
  if (frames.some(f => f.lumaMean < 1)) problems.push('all-zero luma');
  const outOfOrder = frames.some((f, i) => i > 0 && f.ptsUs < frames[i - 1].ptsUs);
  console.log(
    `  ${problems.length ? 'FAIL' : 'ok  '} ${label}: ${frames.length}/${packets.length} frames, presentation-ordered=${!outOfOrder}${problems.length ? ` - ${problems.join('; ')}` : ''}`,
  );
  return problems.length === 0;
};

const sameImages = (a, b) => {
  const byPts = new Map(a.map(f => [f.ptsUs, f.hash]));
  return b.length === a.length && b.every(f => byPts.get(f.ptsUs) === f.hash);
};

const verifyStream = async (moduleFile, factoryName, label, { extradata, packets }) => {
  const factory = loadClassicModule(join(wasmDir, moduleFile));
  if (typeof factory !== 'function') throw new Error(`${moduleFile} does not export ${factoryName}`);
  const mod = await factory();
  const ext = toHeap(mod, extradata);
  const open = () => {
    const r = mod._dec_open(ext, extradata.length);
    if (r < 0) throw new Error(`dec_open failed: ${r}`);
  };
  console.log(`${label} (${moduleFile})`);
  open();
  const interleaved = decodeRun(mod, packets, true);
  let ok = checkRun('send/receive interleaved', packets, interleaved);
  mod._dec_reset();
  const batched = decodeRun(mod, packets, false);
  ok = checkRun('send all, then drain + receive (after dec_reset)', packets, batched) && ok;
  const identical = sameImages(interleaved, batched);
  console.log(`  ${identical ? 'ok  ' : 'FAIL'} luma identical across both runs`);
  mod._dec_close();
  open();
  ok = checkRun('after dec_close + dec_open', packets, decodeRun(mod, packets, true)) && ok;
  mod._dec_close();
  mod._free(ext);
  console.log(`  first frame luma mean ${interleaved[0]?.lumaMean.toFixed(1)}`);
  return ok && identical;
};

encode('vp9.ivf', ['-c:v', 'libvpx-vp9']);
encode('av1.ivf', ['-c:v', 'libaom-av1', '-cpu-used', '8']);
encode('av1.mp4', ['-c:v', 'libaom-av1', '-cpu-used', '8']);
const results = [
  await verifyStream('vp9.js', 'createVp9Decoder', 'VP9 IVF', {
    extradata: new Uint8Array(0),
    packets: readIvf('vp9.ivf'),
  }),
  await verifyStream('av1.js', 'createAv1Decoder', 'AV1 IVF', {
    extradata: new Uint8Array(0),
    packets: readIvf('av1.ivf'),
  }),
  await verifyStream('av1.js', 'createAv1Decoder', 'AV1 MP4 samples + av1C', mp4Stream('av1.mp4', 'av1C')),
];
const passed = results.every(Boolean);
console.log(passed ? 'ALL PASSED' : 'FAILURES');
process.exit(passed ? 0 : 1);
