import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type WxtViteConfig } from 'wxt';

// eslint-disable-next-line no-restricted-imports
import toUtf8 from './scripts/vite-plugin-to-utf8';

const NO_GPU = process.env.NO_GPU === 'true' || process.env.NO_GPU === '1';

const debugChromiumArgs = [
  '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',
  '--disable-gpu',
  '--disable-gpu-compositing',
];

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () =>
    ({
      plugins: [toUtf8(), tailwindcss()],
    }) as WxtViteConfig,
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
      } as never,
    },
    permissions: ['tabs', 'storage'],
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
