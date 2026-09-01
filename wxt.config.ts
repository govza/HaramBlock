import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'wxt';

// eslint-disable-next-line no-restricted-imports
import toUtf8 from './scripts/vite-plugin-to-utf8';

const DEFAULT_OTEL_ENDPOINT = 'http://localhost:4318';
const NO_GPU = process.env.NO_GPU === 'true' || process.env.NO_GPU === '1';
const WEBGPU_WARMUP_RUNS = Number.parseInt(process.env.WEBGPU_WARMUP_RUNS ?? '2', 10);

const debugChromiumArgs = [
  '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',
  '--disable-gpu',
  '--disable-gpu-compositing',
];

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: env => {
    const otelEndpoint = loadEnv(env.mode, process.cwd(), 'WXT_').WXT_OTEL_ENDPOINT ?? DEFAULT_OTEL_ENDPOINT;
    return {
      plugins: [toUtf8(), tailwindcss()],
      define: {
        __WEBGPU_WARMUP_RUNS__: JSON.stringify(Number.isFinite(WEBGPU_WARMUP_RUNS) ? WEBGPU_WARMUP_RUNS : 2),
        __HB_TELEMETRY_ENABLED__: JSON.stringify(env.mode === 'development' && otelEndpoint !== ''),
        __HB_OTEL_ENDPOINT__: JSON.stringify(otelEndpoint),
      },
    };
  },
  modules: ['@wxt-dev/module-react', '@wxt-dev/i18n/module'],
  webExt: {
    chromiumArgs: NO_GPU ? debugChromiumArgs : [],
  },
  manifestVersion: 3,
  manifest: {
    name: '__MSG_Extension_name__',
    description: '__MSG_Extension_description__',
    default_locale: 'en',
    browser_specific_settings: {
      gecko: {
        id: 'admin@haramblock.com',
        strict_min_version: '142.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: {
        strict_min_version: '142.0',
      },
    },
    permissions: ['tabs', 'storage', 'contextMenus'],
    host_permissions: ['<all_urls>'],
    options_page: 'options.html',
    web_accessible_resources: [
      {
        resources: ['message-channel.html', 'message-channel.js'],
        matches: ['<all_urls>'],
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    action: {
      default_title: '__MSG_Extension_name__',
    },
  },
});
