export interface ComposedTreeWalkResult {
  images: HTMLImageElement[];
  videos: HTMLVideoElement[];
  shadowRoots: ShadowRoot[];
  possibleHosts: Element[];
}

export type ComposedTreeRoot = Element | Document | ShadowRoot;

export const walkComposedTree = (root: ComposedTreeRoot): ComposedTreeWalkResult => {
  const result: ComposedTreeWalkResult = { images: [], videos: [], shadowRoots: [], possibleHosts: [] };
  const origin =
    root.nodeType === Node.DOCUMENT_NODE ? (root as Document).documentElement : (root as Element | ShadowRoot);
  if (!origin) return result;

  if (origin.nodeType === Node.ELEMENT_NODE) {
    visitElement(origin as Element, result);
  } else if (origin.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    result.shadowRoots.push(origin as ShadowRoot);
  }
  origin.querySelectorAll('*').forEach(el => visitElement(el, result));
  return result;
};

const visitElement = (element: Element, result: ComposedTreeWalkResult): void => {
  if (element.tagName === 'IMG') {
    result.images.push(element as HTMLImageElement);
  } else if (element.tagName === 'VIDEO') {
    result.videos.push(element as HTMLVideoElement);
  }

  const shadow = element.shadowRoot;
  if (shadow) {
    result.shadowRoots.push(shadow);
    shadow.querySelectorAll('*').forEach(el => visitElement(el, result));
  } else if (element.tagName.includes('-')) {
    result.possibleHosts.push(element);
  }
};
