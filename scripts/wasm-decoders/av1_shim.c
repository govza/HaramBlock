#include <dav1d/dav1d.h>
#include <emscripten.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

#define AV1C_HEADER_LEN 4

static Dav1dContext *ctx;
static Dav1dPicture current;
static int has_current;

static Dav1dPicture *queue;
static int queue_head, queue_len, queue_cap;

static uint8_t *config_obus;
static int config_obus_len;
static int config_pending;

static void free_owned_buffer(const uint8_t *buf, void *cookie) { free((void *)buf); }

static int queue_push(Dav1dPicture *pic) {
  if (queue_len == queue_cap) {
    int cap = queue_cap ? queue_cap * 2 : 8;
    Dav1dPicture *grown = malloc(sizeof(*grown) * cap);
    if (!grown) return DAV1D_ERR(ENOMEM);
    for (int i = 0; i < queue_len; i++) grown[i] = queue[(queue_head + i) % queue_cap];
    free(queue);
    queue = grown;
    queue_head = 0;
    queue_cap = cap;
  }
  queue[(queue_head + queue_len) % queue_cap] = *pic;
  queue_len++;
  return 0;
}

static void release_all_pictures(void) {
  while (queue_len) {
    dav1d_picture_unref(&queue[queue_head]);
    queue_head = (queue_head + 1) % queue_cap;
    queue_len--;
  }
  if (has_current) {
    dav1d_picture_unref(&current);
    has_current = 0;
  }
}

/** Moves every picture dav1d can output right now into the queue; returns <0 only on a real error. */
static int collect_pictures(void) {
  for (;;) {
    Dav1dPicture pic = {0};
    int r = dav1d_get_picture(ctx, &pic);
    if (r == DAV1D_ERR(EAGAIN)) return 0;
    if (r < 0) return r;
    r = queue_push(&pic);
    if (r < 0) {
      dav1d_picture_unref(&pic);
      return r;
    }
  }
}

static int feed(Dav1dData *data) {
  while (data->sz > 0) {
    int r = dav1d_send_data(ctx, data);
    if (r < 0 && r != DAV1D_ERR(EAGAIN)) {
      dav1d_data_unref(data);
      return r;
    }
    int stalled = r == DAV1D_ERR(EAGAIN);
    int queued_before = queue_len;
    r = collect_pictures();
    if (r >= 0 && stalled && queue_len == queued_before) r = DAV1D_ERR(EAGAIN);
    if (r < 0) {
      if (data->sz > 0) dav1d_data_unref(data);
      return r;
    }
  }
  return 0;
}

/** av1C carries the sequence header as configOBUs; containers may omit it from keyframes, so it is replayed after open/reset. */
static int send_config_obus(void) {
  config_pending = 0;
  if (!config_obus_len) return 0;
  Dav1dData data;
  uint8_t *copy = dav1d_data_create(&data, config_obus_len);
  if (!copy) return DAV1D_ERR(ENOMEM);
  memcpy(copy, config_obus, config_obus_len);
  return feed(&data);
}

EMSCRIPTEN_KEEPALIVE int dec_open(const uint8_t *extradata, int extradata_len) {
  Dav1dSettings s;
  dav1d_default_settings(&s);
  s.n_threads = 1;
  s.max_frame_delay = 1;
  int r = dav1d_open(&ctx, &s);
  if (r < 0) return r;
  if (extradata_len > AV1C_HEADER_LEN && (extradata[0] & 0x80)) {
    config_obus_len = extradata_len - AV1C_HEADER_LEN;
    config_obus = malloc(config_obus_len);
    if (!config_obus) return DAV1D_ERR(ENOMEM);
    memcpy(config_obus, extradata + AV1C_HEADER_LEN, config_obus_len);
  }
  config_pending = 1;
  return 0;
}

EMSCRIPTEN_KEEPALIVE void dec_close(void) {
  if (!ctx) return;
  release_all_pictures();
  dav1d_close(&ctx);
  free(queue);
  queue = NULL;
  queue_head = queue_len = queue_cap = 0;
  free(config_obus);
  config_obus = NULL;
  config_obus_len = 0;
}

EMSCRIPTEN_KEEPALIVE void dec_reset(void) {
  release_all_pictures();
  dav1d_flush(ctx);
  config_pending = 1;
}

EMSCRIPTEN_KEEPALIVE int dec_send(uint8_t *buf, int len, double pts_us) {
  if (config_pending) {
    int r = send_config_obus();
    if (r < 0) {
      free(buf);
      return r;
    }
  }
  Dav1dData data;
  int r = dav1d_data_wrap(&data, buf, len, free_owned_buffer, NULL);
  if (r < 0) {
    free(buf);
    return r;
  }
  data.m.timestamp = (int64_t)pts_us;
  return feed(&data);
}

EMSCRIPTEN_KEEPALIVE int dec_drain(void) { return collect_pictures(); }

EMSCRIPTEN_KEEPALIVE int dec_receive(void) {
  if (has_current) {
    dav1d_picture_unref(&current);
    has_current = 0;
  }
  if (!queue_len) {
    int r = collect_pictures();
    if (r < 0) return r;
    if (!queue_len) return 0;
  }
  current = queue[queue_head];
  queue_head = (queue_head + 1) % queue_cap;
  queue_len--;
  has_current = 1;
  return 1;
}

EMSCRIPTEN_KEEPALIVE int dec_width(void) { return has_current ? current.p.w : 0; }

EMSCRIPTEN_KEEPALIVE int dec_height(void) { return has_current ? current.p.h : 0; }

EMSCRIPTEN_KEEPALIVE uint8_t *dec_plane(int i) { return has_current ? current.data[i] : NULL; }

EMSCRIPTEN_KEEPALIVE int dec_stride(int i) { return has_current ? (int)current.stride[i ? 1 : 0] : 0; }

EMSCRIPTEN_KEEPALIVE double dec_pts(void) { return has_current ? (double)current.m.timestamp : 0; }

EMSCRIPTEN_KEEPALIVE int dec_format(void) {
  return has_current && current.p.bpc == 8 && current.p.layout == DAV1D_PIXEL_LAYOUT_I420 ? 0 : 1;
}
