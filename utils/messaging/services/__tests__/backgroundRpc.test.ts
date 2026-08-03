import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setRpcContext } from '@/utils/messaging/rpcContext';
import { BackgroundRpc } from '@/utils/messaging/services/backgroundRpc';

import type { FrameInferenceResult, ImageInferenceResult } from '@/utils/types';

const makeRpc = (): BackgroundRpc =>
  // Subscription paths never touch the injected services
  new BackgroundRpc(undefined as never, undefined as never, undefined as never, undefined as never, undefined as never);

const frameResults = [] as FrameInferenceResult[];
const imageResults = [] as ImageInferenceResult[];

describe('BackgroundRpc subscription reaping', () => {
  let rpc: BackgroundRpc;

  beforeEach(() => {
    rpc = makeRpc();
    setRpcContext({});
  });

  it('delivers emissions to a registered subscriber', () => {
    setRpcContext({ tabId: 1, frameId: 0 });
    const callback = vi.fn();
    rpc.onFramePredictions(callback);

    rpc.emitFramePredictions(frameResults, 'example.com');

    expect(callback).toHaveBeenCalledWith({ results: frameResults, hostname: 'example.com' });
  });

  it('releaseTab drops every subscription kind owned by that tab', () => {
    setRpcContext({ tabId: 7, frameId: 0 });
    const image = vi.fn();
    const frame = vi.fn();
    const gif = vi.fn();
    const toggle = vi.fn();
    rpc.onImagePredictions(image);
    rpc.onFramePredictions(frame);
    rpc.onGifFramePredictions(gif);
    rpc.onContextMenuToggle(toggle);

    rpc.releaseTab(7);

    rpc.emitImagePredictions(imageResults, 'example.com');
    rpc.emitFramePredictions(frameResults, 'example.com');
    rpc.emitGifFramePredictions([], 'example.com');
    rpc.emitContextMenuToggle('src', 'visible');

    expect(image).not.toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
    expect(gif).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('releaseTab leaves other tabs and context-free subscribers alone', () => {
    setRpcContext({ tabId: 7, frameId: 0 });
    const doomed = vi.fn();
    rpc.onFramePredictions(doomed);

    setRpcContext({ tabId: 8, frameId: 0 });
    const otherTab = vi.fn();
    rpc.onFramePredictions(otherTab);

    setRpcContext({});
    const popup = vi.fn();
    rpc.onFramePredictions(popup);

    rpc.releaseTab(7);
    rpc.emitFramePredictions(frameResults, 'example.com');

    expect(doomed).not.toHaveBeenCalled();
    expect(otherTab).toHaveBeenCalledOnce();
    expect(popup).toHaveBeenCalledOnce();
  });

  it('a resubscribe from the same tab+frame evicts the stale entry of the same kind', () => {
    setRpcContext({ tabId: 3, frameId: 5 });
    const stale = vi.fn();
    rpc.onFramePredictions(stale);

    setRpcContext({ tabId: 3, frameId: 5 });
    const fresh = vi.fn();
    rpc.onFramePredictions(fresh);

    rpc.emitFramePredictions(frameResults, 'example.com');

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
  });

  it('same tab, different frames coexist', () => {
    setRpcContext({ tabId: 3, frameId: 0 });
    const top = vi.fn();
    rpc.onFramePredictions(top);

    setRpcContext({ tabId: 3, frameId: 42 });
    const iframe = vi.fn();
    rpc.onFramePredictions(iframe);

    rpc.emitFramePredictions(frameResults, 'example.com');

    expect(top).toHaveBeenCalledOnce();
    expect(iframe).toHaveBeenCalledOnce();
  });

  it('resubscribe does not evict a different kind from the same frame', () => {
    setRpcContext({ tabId: 3, frameId: 0 });
    const image = vi.fn();
    rpc.onImagePredictions(image);

    setRpcContext({ tabId: 3, frameId: 0 });
    rpc.onFramePredictions(vi.fn());

    rpc.emitImagePredictions(imageResults, 'example.com');
    expect(image).toHaveBeenCalledOnce();
  });

  it('explicit unsubscribe still works', () => {
    setRpcContext({ tabId: 1, frameId: 0 });
    const callback = vi.fn();
    const id = rpc.onFramePredictions(callback);

    rpc.offFramePredictions(id);
    rpc.emitFramePredictions(frameResults, 'example.com');

    expect(callback).not.toHaveBeenCalled();
  });
});
