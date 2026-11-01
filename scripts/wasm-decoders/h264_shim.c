#include <emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/mem.h>
#include <stdlib.h>
#include <string.h>

static AVCodecContext *ctx;
static AVPacket *packet;
static AVFrame *current;
static int has_current;

static AVFrame **queue;
static int queue_head, queue_len, queue_cap;

static int queue_push(AVFrame *frame) {
  if (queue_len == queue_cap) {
    int cap = queue_cap ? queue_cap * 2 : 8;
    AVFrame **grown = malloc(sizeof(*grown) * cap);
    if (!grown) return AVERROR(ENOMEM);
    for (int i = 0; i < queue_len; i++) grown[i] = queue[(queue_head + i) % queue_cap];
    free(queue);
    queue = grown;
    queue_head = 0;
    queue_cap = cap;
  }
  queue[(queue_head + queue_len) % queue_cap] = frame;
  queue_len++;
  return 0;
}

static void release_all_frames(void) {
  while (queue_len) {
    av_frame_free(&queue[queue_head]);
    queue_head = (queue_head + 1) % queue_cap;
    queue_len--;
  }
  if (has_current) {
    av_frame_unref(current);
    has_current = 0;
  }
}

/** Moves every frame libavcodec can output right now into the queue; returns <0 only on a real error. */
static int collect_frames(void) {
  for (;;) {
    AVFrame *frame = av_frame_alloc();
    if (!frame) return AVERROR(ENOMEM);
    int r = avcodec_receive_frame(ctx, frame);
    if (r < 0) {
      av_frame_free(&frame);
      return r == AVERROR(EAGAIN) || r == AVERROR_EOF ? 0 : r;
    }
    r = queue_push(frame);
    if (r < 0) {
      av_frame_free(&frame);
      return r;
    }
  }
}

static int send_until_accepted(const AVPacket *pkt) {
  for (;;) {
    int r = avcodec_send_packet(ctx, pkt);
    if (r != AVERROR(EAGAIN)) return r == AVERROR_EOF ? 0 : r;
    int queued_before = queue_len;
    r = collect_frames();
    if (r < 0) return r;
    if (queue_len == queued_before) return AVERROR(EAGAIN);
  }
}

static int copy_extradata(const uint8_t *extradata, int extradata_len) {
  if (extradata_len <= 0) return 0;
  ctx->extradata = av_mallocz(extradata_len + AV_INPUT_BUFFER_PADDING_SIZE);
  if (!ctx->extradata) return AVERROR(ENOMEM);
  memcpy(ctx->extradata, extradata, extradata_len);
  ctx->extradata_size = extradata_len;
  return 0;
}

EMSCRIPTEN_KEEPALIVE void dec_close(void) {
  if (ctx) release_all_frames();
  avcodec_free_context(&ctx);
  av_packet_free(&packet);
  av_frame_free(&current);
  free(queue);
  queue = NULL;
  queue_head = queue_len = queue_cap = 0;
}

EMSCRIPTEN_KEEPALIVE int dec_open(const uint8_t *extradata, int extradata_len) {
  const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_H264);
  if (!codec) return AVERROR_DECODER_NOT_FOUND;
  ctx = avcodec_alloc_context3(codec);
  packet = av_packet_alloc();
  current = av_frame_alloc();
  if (!ctx || !packet || !current) {
    dec_close();
    return AVERROR(ENOMEM);
  }
  ctx->thread_count = 1;
  ctx->pkt_timebase = (AVRational){1, 1000000};
  int r = copy_extradata(extradata, extradata_len);
  if (r >= 0) r = avcodec_open2(ctx, codec, NULL);
  if (r < 0) {
    dec_close();
    return r;
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE void dec_reset(void) {
  release_all_frames();
  avcodec_flush_buffers(ctx);
}

EMSCRIPTEN_KEEPALIVE int dec_send(uint8_t *buf, int len, double pts_us) {
  int r = av_new_packet(packet, len);
  if (r < 0) {
    free(buf);
    return r;
  }
  memcpy(packet->data, buf, len);
  free(buf);
  packet->pts = (int64_t)pts_us;
  packet->dts = AV_NOPTS_VALUE;
  r = send_until_accepted(packet);
  av_packet_unref(packet);
  return r < 0 ? r : 0;
}

EMSCRIPTEN_KEEPALIVE int dec_drain(void) {
  int r = send_until_accepted(NULL);
  return r < 0 ? r : collect_frames();
}

EMSCRIPTEN_KEEPALIVE int dec_receive(void) {
  if (has_current) {
    av_frame_unref(current);
    has_current = 0;
  }
  if (!queue_len) {
    int r = collect_frames();
    if (r < 0) return r;
    if (!queue_len) return 0;
  }
  AVFrame *next = queue[queue_head];
  queue_head = (queue_head + 1) % queue_cap;
  queue_len--;
  av_frame_move_ref(current, next);
  av_frame_free(&next);
  has_current = 1;
  return 1;
}

EMSCRIPTEN_KEEPALIVE int dec_width(void) { return has_current ? current->width : 0; }

EMSCRIPTEN_KEEPALIVE int dec_height(void) { return has_current ? current->height : 0; }

EMSCRIPTEN_KEEPALIVE uint8_t *dec_plane(int i) { return has_current ? current->data[i] : NULL; }

EMSCRIPTEN_KEEPALIVE int dec_stride(int i) { return has_current ? current->linesize[i] : 0; }

EMSCRIPTEN_KEEPALIVE double dec_pts(void) {
  if (!has_current) return 0;
  int64_t pts = current->pts != AV_NOPTS_VALUE ? current->pts : current->best_effort_timestamp;
  return (double)pts;
}

EMSCRIPTEN_KEEPALIVE int dec_format(void) {
  return has_current && (current->format == AV_PIX_FMT_YUV420P || current->format == AV_PIX_FMT_YUVJ420P) ? 0 : 1;
}
