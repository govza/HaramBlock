import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  injectGlobalHidingDomStyles,
  injectVideoDiscoveryHidingStyles,
  markVideoDiscovered,
  VIDEO_DISCOVERED_ATTR,
} from '@/entrypoints/content/presentation/styleInjecting';

describe('video bootstrap styles', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hides light-DOM videos and Reddit player hosts before discovery', () => {
    const remove = vi.fn();
    const style = { textContent: '', remove };
    const appendChild = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => style),
      head: { appendChild },
      documentElement: { appendChild },
    });

    const startup = injectGlobalHidingDomStyles();
    expect(style.textContent).toContain('video,');
    expect(style.textContent).toContain('shreddit-player');
    startup.remove();
    expect(remove).toHaveBeenCalledOnce();

    remove.mockClear();
    const discovery = injectVideoDiscoveryHidingStyles();
    expect(style.textContent).toContain(`video:not([${VIDEO_DISCOVERED_ATTR}])`);
    expect(style.textContent).toContain(`shreddit-player:not([${VIDEO_DISCOVERED_ATTR}])`);
    discovery.remove();
    expect(remove).toHaveBeenCalledOnce();
    expect(appendChild).toHaveBeenCalledTimes(2);
  });

  it('reveals every shadow host only after its video is marked protected', () => {
    class FakeShadowRoot {
      constructor(readonly host: { setAttribute: ReturnType<typeof vi.fn>; getRootNode: () => object }) {}
    }
    vi.stubGlobal('ShadowRoot', FakeShadowRoot);

    const documentRoot = {};
    const outerHost = { setAttribute: vi.fn(), getRootNode: () => documentRoot };
    const outerRoot = new FakeShadowRoot(outerHost);
    const innerHost = { setAttribute: vi.fn(), getRootNode: () => outerRoot };
    const innerRoot = new FakeShadowRoot(innerHost);
    const videoSetAttribute = vi.fn();
    const video = { setAttribute: videoSetAttribute, getRootNode: () => innerRoot } as unknown as HTMLVideoElement;

    markVideoDiscovered(video);

    expect(videoSetAttribute).toHaveBeenCalledWith(VIDEO_DISCOVERED_ATTR, '');
    expect(innerHost.setAttribute).toHaveBeenCalledWith(VIDEO_DISCOVERED_ATTR, '');
    expect(outerHost.setAttribute).toHaveBeenCalledWith(VIDEO_DISCOVERED_ATTR, '');
  });
});
