#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <vpx/vp8dx.h>
#include <vpx/vpx_decoder.h>

#define ERR_NOMEM (-1000)

/**
 * A decoded frame: its planes point into libvpx's buffer pool until the next vpx_codec_decode,
 * unless `owned` holds a private copy made before that call could recycle them.
 */
typedef struct {
  uint8_t *planes[3];
  int stride[3];
  int width, height, format;
  double pts_us;
  uint8_t *owned;
} Frame;

static vpx_codec_ctx_t codec;
static int is_open;
static Frame current;
static int has_current;

static Frame *queue;
static int queue_head, queue_len, queue_cap;

static void release_frame(Frame *frame) {
  free(frame->owned);
  frame->owned = NULL;
}

static int queue_push(const Frame *frame) {
  if (queue_len == queue_cap) {
    int cap = queue_cap ? queue_cap * 2 : 8;
    Frame *grown = malloc(sizeof(*grown) * cap);
    if (!grown) return ERR_NOMEM;
    for (int i = 0; i < queue_len; i++) grown[i] = queue[(queue_head + i) % queue_cap];
    free(queue);
    queue = grown;
    queue_head = 0;
    queue_cap = cap;
  }
  queue[(queue_head + queue_len) % queue_cap] = *frame;
  queue_len++;
  return 0;
}

static void release_all_frames(void) {
  while (queue_len) {
    release_frame(&queue[queue_head]);
    queue_head = (queue_head + 1) % queue_cap;
    queue_len--;
  }
  if (has_current) {
    release_frame(&current);
    has_current = 0;
  }
}

static int plane_rows(const Frame *frame, int plane) {
  return plane ? (frame->height + 1) / 2 : frame->height;
}

static int plane_bytes_per_row(const Frame *frame, int plane) {
  return plane ? (frame->width + 1) / 2 : frame->width;
}

static int take_ownership(Frame *frame) {
  if (frame->owned) return 0;
  size_t total = 0;
  for (int p = 0; p < 3; p++) total += (size_t)plane_bytes_per_row(frame, p) * plane_rows(frame, p);
  uint8_t *copy = malloc(total ? total : 1);
  if (!copy) return ERR_NOMEM;
  uint8_t *dst = copy;
  for (int p = 0; p < 3; p++) {
    int row_bytes = plane_bytes_per_row(frame, p);
    for (int y = 0; y < plane_rows(frame, p); y++) {
      memcpy(dst + (size_t)y * row_bytes, frame->planes[p] + (size_t)y * frame->stride[p], row_bytes);
    }
    frame->planes[p] = dst;
    frame->stride[p] = row_bytes;
    dst += (size_t)row_bytes * plane_rows(frame, p);
  }
  frame->owned = copy;
  return 0;
}

static int detach_frames_from_decoder(void) {
  for (int i = 0; i < queue_len; i++) {
    Frame *frame = &queue[(queue_head + i) % queue_cap];
    if (!frame->format) {
      int r = take_ownership(frame);
      if (r < 0) return r;
    }
  }
  if (has_current && !current.format) return take_ownership(&current);
  return 0;
}

static void frame_from_image(Frame *frame, const vpx_image_t *img, double pts_us) {
  memset(frame, 0, sizeof(*frame));
  frame->width = (int)img->d_w;
  frame->height = (int)img->d_h;
  frame->format = img->fmt == VPX_IMG_FMT_I420 ? 0 : 1;
  frame->pts_us = pts_us;
  if (frame->format) return;
  for (int p = 0; p < 3; p++) {
    frame->planes[p] = img->planes[p];
    frame->stride[p] = img->stride[p];
  }
}

EMSCRIPTEN_KEEPALIVE int dec_open(const uint8_t *extradata, int extradata_len) {
  vpx_codec_dec_cfg_t cfg = {.threads = 1};
  vpx_codec_err_t r = vpx_codec_dec_init(&codec, vpx_codec_vp9_dx(), &cfg, 0);
  if (r) return -(int)r;
  is_open = 1;
  return 0;
}

EMSCRIPTEN_KEEPALIVE void dec_close(void) {
  if (!is_open) return;
  release_all_frames();
  vpx_codec_destroy(&codec);
  is_open = 0;
  free(queue);
  queue = NULL;
  queue_head = queue_len = queue_cap = 0;
}

EMSCRIPTEN_KEEPALIVE void dec_reset(void) { release_all_frames(); }

EMSCRIPTEN_KEEPALIVE int dec_send(uint8_t *buf, int len, double pts_us) {
  int r = detach_frames_from_decoder();
  if (r < 0) {
    free(buf);
    return r;
  }
  vpx_codec_err_t err = vpx_codec_decode(&codec, buf, (unsigned int)len, NULL, 0);
  free(buf);
  if (err) return -(int)err;
  vpx_codec_iter_t iter = NULL;
  vpx_image_t *img;
  while ((img = vpx_codec_get_frame(&codec, &iter))) {
    Frame frame;
    frame_from_image(&frame, img, pts_us);
    r = queue_push(&frame);
    if (r < 0) return r;
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE int dec_drain(void) { return 0; }

EMSCRIPTEN_KEEPALIVE int dec_receive(void) {
  if (has_current) {
    release_frame(&current);
    has_current = 0;
  }
  if (!queue_len) return 0;
  current = queue[queue_head];
  queue_head = (queue_head + 1) % queue_cap;
  queue_len--;
  has_current = 1;
  return 1;
}

EMSCRIPTEN_KEEPALIVE int dec_width(void) { return has_current ? current.width : 0; }

EMSCRIPTEN_KEEPALIVE int dec_height(void) { return has_current ? current.height : 0; }

EMSCRIPTEN_KEEPALIVE uint8_t *dec_plane(int i) { return has_current ? current.planes[i] : NULL; }

EMSCRIPTEN_KEEPALIVE int dec_stride(int i) { return has_current ? current.stride[i] : 0; }

EMSCRIPTEN_KEEPALIVE double dec_pts(void) { return has_current ? current.pts_us : 0; }

EMSCRIPTEN_KEEPALIVE int dec_format(void) { return has_current ? current.format : 1; }
