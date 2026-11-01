#!/bin/bash
# Runs inside emscripten/emsdk:6.0.12 with this directory mounted at /src; see README.md.
set -euo pipefail

DAV1D_TAG=1.5.4
LIBVPX_TAG=v1.17.0
FFMPEG_TAG=n9.0.2

SRC=/src
WORK=$SRC/work
OUT=$SRC/out
SIMD=-msimd128
JOBS=$(nproc)

INTERFACE=_malloc,_free,_dec_open,_dec_close,_dec_reset,_dec_send,_dec_drain,_dec_receive,_dec_width,_dec_height,_dec_plane,_dec_stride,_dec_pts,_dec_format
LINK=(-O3 "$SIMD" -sMODULARIZE=1 -sENVIRONMENT=worker,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB
  -sFILESYSTEM=0 -sEXPORTED_RUNTIME_METHODS=HEAPU8 "-sEXPORTED_FUNCTIONS=$INTERFACE")

mkdir -p "$WORK" "$OUT"
cd "$WORK"

clone() {
  local dir=$1 tag=$2 url=$3
  [ -d "$dir" ] || git clone -q --depth 1 --branch "$tag" "$url" "$dir"
}

build_av1() {
  pip install -q meson ninja 2>/dev/null || pip install -q --break-system-packages meson ninja
  clone dav1d "$DAV1D_TAG" https://code.videolan.org/videolan/dav1d.git
  rm -rf dav1d-build
  meson setup dav1d-build dav1d --cross-file "$SRC/cross.meson" --buildtype=release -Ddefault_library=static \
    -Denable_asm=false -Denable_tools=false -Denable_tests=false -Denable_examples=false -Dbitdepths=8 \
    -Dlogging=false -Dc_args="-O3 $SIMD"
  ninja -C dav1d-build
  emcc "$SRC/av1_shim.c" -Idav1d/include -Idav1d-build/include dav1d-build/src/libdav1d.a \
    "${LINK[@]}" -sEXPORT_NAME=createAv1Decoder -o "$OUT/av1.js"
}

build_vp9() {
  clone libvpx "$LIBVPX_TAG" https://chromium.googlesource.com/webm/libvpx
  rm -rf libvpx-build && mkdir libvpx-build
  (cd libvpx-build && emconfigure ../libvpx/configure --target=generic-gnu --disable-multithread --disable-examples \
    --disable-tools --disable-docs --disable-unit-tests --disable-vp8 --disable-vp9-encoder \
    --disable-runtime-cpu-detect --enable-vp9-decoder --extra-cflags="-O3 $SIMD" && emmake make -j"$JOBS")
  emcc "$SRC/vp9_shim.c" -Ilibvpx libvpx-build/libvpx.a \
    "${LINK[@]}" -sEXPORT_NAME=createVp9Decoder -o "$OUT/vp9.js"
}

build_h264() {
  clone ffmpeg "$FFMPEG_TAG" https://git.ffmpeg.org/ffmpeg.git
  rm -rf ffmpeg-build ffmpeg-install && mkdir ffmpeg-build
  (cd ffmpeg-build && ../ffmpeg/configure --prefix="$WORK/ffmpeg-install" \
    --target-os=none --arch=x86_32 --enable-cross-compile --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
    --disable-everything --enable-decoder=h264 --enable-parser=h264 \
    --disable-asm --disable-inline-asm --disable-x86asm \
    --disable-pthreads --disable-w32threads --disable-os2threads \
    --disable-programs --disable-doc --disable-network \
    --disable-avformat --disable-avdevice --disable-swscale --disable-swresample --disable-avfilter \
    --disable-runtime-cpudetect --disable-debug --disable-autodetect \
    --extra-cflags="-O3 $SIMD" && make -j"$JOBS" && make install)
  emcc "$SRC/h264_shim.c" -Iffmpeg-install/include ffmpeg-install/lib/libavcodec.a ffmpeg-install/lib/libavutil.a \
    "${LINK[@]}" -sEXPORT_NAME=createH264Decoder -o "$OUT/h264.js"
}

targets=("$@")
[ ${#targets[@]} -gt 0 ] || targets=(av1 vp9 h264)
for target in "${targets[@]}"; do "build_$target"; done
ls -l "$OUT"
