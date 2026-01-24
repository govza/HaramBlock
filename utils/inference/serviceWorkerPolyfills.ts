/**
 * Polyfills for running ONNX Runtime Web in service worker environment.
 * This file MUST be imported before any onnxruntime-web imports.
 */

// Polyfill window for service worker environment
// eslint-disable-next-line no-restricted-globals
if (typeof window === 'undefined') {
  // @ts-expect-error - Polyfill for service worker
  globalThis.window = globalThis;
}

// Polyfill XMLHttpRequest for service worker environment (ONNX Runtime uses it internally)
if (typeof XMLHttpRequest === 'undefined') {
  // @ts-expect-error - Polyfill for service worker
  globalThis.XMLHttpRequest = class XMLHttpRequest {
    private _method = '';
    private _url = '';
    private _responseType = '';
    private _response: ArrayBuffer | string | null = null;
    private _status = 0;
    private _readyState = 0;
    private _async = true;

    onload: (() => void) | null = null;
    onerror: ((e: Error) => void) | null = null;
    onprogress: (() => void) | null = null;
    onreadystatechange: (() => void) | null = null;

    get responseType() {
      return this._responseType;
    }
    set responseType(value: string) {
      this._responseType = value;
    }
    get response() {
      return this._response;
    }
    get status() {
      return this._status;
    }
    get readyState() {
      return this._readyState;
    }

    open(method: string, url: string, async = true) {
      this._method = method;
      this._async = async;

      // Resolve relative URLs against the extension origin
      if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
        // Get extension base URL
        const baseUrl = self.location?.origin || '';
        this._url = new URL(url, baseUrl).href;
      } else if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('blob:')) {
        // Relative path without leading slash
        const baseUrl = self.location?.origin || '';
        this._url = new URL(`/${url}`, baseUrl).href;
      } else {
        this._url = url;
      }

      this._readyState = 1;
      // eslint-disable-next-line no-console -- Polyfill runs before logger is available
      console.debug('[XMLHttpRequest polyfill] open:', this._method, this._url);
    }

    send() {
      // eslint-disable-next-line no-console -- Polyfill runs before logger is available
      console.debug('[XMLHttpRequest polyfill] send:', this._url, 'responseType:', this._responseType);

      fetch(this._url, { method: this._method })
        .then(async res => {
          // eslint-disable-next-line no-console -- Polyfill runs before logger is available
          console.debug('[XMLHttpRequest polyfill] response status:', res.status, 'for', this._url);
          this._status = res.status;
          this._readyState = 4;

          if (!res.ok) {
            console.error('[XMLHttpRequest polyfill] fetch failed:', res.status, res.statusText);
            this._response = null;
            this.onerror?.(new Error(`HTTP ${res.status}: ${res.statusText}`));
            return;
          }

          if (this._responseType === 'arraybuffer') {
            this._response = await res.arrayBuffer();
            // eslint-disable-next-line no-console -- Polyfill runs before logger is available
            console.debug('[XMLHttpRequest polyfill] arraybuffer size:', this._response.byteLength);
          } else {
            this._response = await res.text();
            // eslint-disable-next-line no-console -- Polyfill runs before logger is available
            console.debug('[XMLHttpRequest polyfill] text length:', this._response.length);
          }

          this.onreadystatechange?.();
          this.onload?.();
        })
        .catch(e => {
          console.error('[XMLHttpRequest polyfill] fetch error:', e);
          this._readyState = 4;
          this._status = 0;
          this._response = null;
          this.onreadystatechange?.();
          this.onerror?.(e instanceof Error ? e : new Error(String(e)));
        });
    }
  };
}

export {};
