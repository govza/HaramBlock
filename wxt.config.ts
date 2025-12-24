import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type WxtViteConfig } from 'wxt';

// eslint-disable-next-line no-restricted-imports
import toUtf8 from './scripts/vite-plugin-to-utf8';

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () =>
    ({
      plugins: [toUtf8(), tailwindcss()],
    }) as WxtViteConfig,
  modules: ['@wxt-dev/module-react', '@wxt-dev/i18n/module'],
  manifestVersion: 3,
  manifest: {
    name: '__MSG_Extension_name__',
    description: '__MSG_Extension_description__',
    default_locale: 'en',
    permissions: ['storage', 'tabs'],
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
