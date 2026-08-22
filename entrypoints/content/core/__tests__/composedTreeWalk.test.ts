// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { walkComposedTree } from '@/entrypoints/content/core/composedTreeWalk';

describe('walkComposedTree', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const img = (src: string): HTMLImageElement => {
    const el = document.createElement('img');
    el.src = src;
    return el;
  };

  it('collects media in the light DOM, including the root element itself', () => {
    const root = img('https://example.com/root.jpg');
    const video = document.createElement('video');
    root.appendChild(video);

    const result = walkComposedTree(root);

    expect(result.images).toEqual([root]);
    expect(result.videos).toEqual([video]);
  });

  it('collects nested light-DOM media under a container', () => {
    const container = document.createElement('div');
    const a = img('https://example.com/a.jpg');
    const b = img('https://example.com/b.jpg');
    container.appendChild(a);
    const inner = document.createElement('section');
    inner.appendChild(b);
    container.appendChild(inner);

    const result = walkComposedTree(container);

    expect(result.images).toEqual([a, b]);
    expect(result.shadowRoots).toEqual([]);
    expect(result.possibleHosts).toEqual([]);
  });

  it('descends into attached shadow roots, including nested ones', () => {
    const container = document.createElement('div');
    const host = document.createElement('div');
    container.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowImg = img('https://example.com/shadow.jpg');
    shadow.appendChild(shadowImg);
    const innerHost = document.createElement('div');
    shadow.appendChild(innerHost);
    const innerShadow = innerHost.attachShadow({ mode: 'open' });
    const innerImg = img('https://example.com/inner.jpg');
    innerShadow.appendChild(innerImg);

    const result = walkComposedTree(container);

    expect(result.images).toEqual([shadowImg, innerImg]);
    expect(result.shadowRoots).toEqual([shadow, innerShadow]);
  });

  it("reports the root element's own shadow root", () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowImg = img('https://example.com/own.jpg');
    shadow.appendChild(shadowImg);

    const result = walkComposedTree(host);

    expect(result.images).toEqual([shadowImg]);
    expect(result.shadowRoots).toEqual([shadow]);
  });

  it('reports custom elements without an attached shadow root as possible hosts', () => {
    const container = document.createElement('div');
    const pending = document.createElement('my-widget');
    const attached = document.createElement('my-panel');
    attached.attachShadow({ mode: 'open' });
    const plain = document.createElement('div');
    container.append(pending, attached, plain);

    const result = walkComposedTree(container);

    expect(result.possibleHosts).toEqual([pending]);
  });

  it('reports possible hosts found inside shadow roots', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const nestedPending = document.createElement('my-lazy');
    shadow.appendChild(nestedPending);

    const result = walkComposedTree(host);

    expect(result.possibleHosts).toEqual([nestedPending]);
  });

  it('reports a shadow root passed as the walk root, so it can be observed', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowImg = img('https://example.com/self.jpg');
    shadow.appendChild(shadowImg);

    const result = walkComposedTree(shadow);

    expect(result.shadowRoots).toEqual([shadow]);
    expect(result.images).toEqual([shadowImg]);
  });

  it('walks a Document root', () => {
    const a = img('https://example.com/doc.jpg');
    document.body.appendChild(a);

    const result = walkComposedTree(document);

    expect(result.images).toEqual([a]);
  });

  it('walks an already-disconnected subtree (removal path)', () => {
    const detached = document.createElement('div');
    const host = document.createElement('div');
    detached.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowImg = img('https://example.com/detached.jpg');
    shadow.appendChild(shadowImg);

    const result = walkComposedTree(detached);

    expect(result.images).toEqual([shadowImg]);
    expect(result.shadowRoots).toEqual([shadow]);
  });
});
