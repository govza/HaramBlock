# WebAssembly video decoders

Sources and build script for `public/wasm-decoders/{vp9,av1,h264}.{js,wasm}`, the software decoders
used for lookahead decoding where WebCodecs is unavailable (Firefox for Android).

| Output   | Library                      | Version (upstream tag, unmodified) | Licence      |
| -------- | ---------------------------- | ---------------------------------- | ------------ |
| `vp9.*`  | libvpx                       | `v1.17.0`                          | BSD-3-Clause |
| `av1.*`  | dav1d                        | `1.5.4`                            | BSD-2-Clause |
| `h264.*` | FFmpeg (`h264` decoder only) | `n9.0.2`                           | LGPL-2.1+    |

Toolchain: Docker image `emscripten/emsdk:6.0.12`
(`sha256:77638e6c215a65f25a704c0c831d5c2463a8c0468a58c6cb82489dbe621dfa05`). All three are built
`-O3 -msimd128` (WebAssembly SIMD required), single-threaded, no asm. FFmpeg is configured with
`--arch=x86_32` only to give its configure a 32-bit arch it knows (wasm32 matches its type sizes);
with all asm disabled the build is plain C.

## Files

- `build.sh` — runs inside the emsdk container; clones the pinned tags, builds the libraries, links
  each shim. `bash build.sh [av1|vp9|h264 ...]` builds a subset.
- `cross.meson` — meson cross file for dav1d.
- `vp9_shim.c`, `av1_shim.c`, `h264_shim.c` — the `dec_*` C interface consumed by
  `utils/lookahead/wasmCodecs.ts`; identical exports in all three.
- `verify.mjs` — encodes test clips with the host `ffmpeg`/`ffprobe` (needs libvpx-vp9, libaom-av1
  and libx264) and decodes them end to end through the interface:
  `node scripts/wasm-decoders/verify.mjs [wasmDir]`.

## Rebuild

Docker only runs inside WSL and Windows paths cannot be bind-mounted, so stage the sources in WSL:

```bash
wsl.exe -e bash -lc '
  set -e
  mkdir -p ~/wasm-decoders-build
  cp /mnt/d/dev/projects/ab/extension/HaramBlock/scripts/wasm-decoders/{build.sh,cross.meson,*.c} ~/wasm-decoders-build/
  sed -i "s/\r$//" ~/wasm-decoders-build/*.sh ~/wasm-decoders-build/*.meson ~/wasm-decoders-build/*.c
  DOCKER_HOST=tcp://127.0.0.1:2375 docker run --rm -v $HOME/wasm-decoders-build:/src emscripten/emsdk:6.0.12 bash /src/build.sh
  cp ~/wasm-decoders-build/out/* /mnt/d/dev/projects/ab/extension/HaramBlock/public/wasm-decoders/'
node scripts/wasm-decoders/verify.mjs
```

Clones are cached in `~/wasm-decoders-build/work`; delete it to start from scratch.

## Licence notice

The VP9 (libvpx, BSD-3-Clause) and AV1 (dav1d, BSD-2-Clause) modules require their copyright notices
to be kept with redistributions. The H.264 module is FFmpeg's LGPL-2.1+ `h264` decoder built from
the unmodified upstream tag above (no `--enable-gpl`/`--enable-nonfree`); this directory is its
corresponding source and build recipe. AVC patents are not licensed; see ADR 0006.
