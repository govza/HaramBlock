import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  test: {
    mockReset: true,
    restoreMocks: true,
    watch: false,
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },

  define: {
    __HB_TELEMETRY_ENABLED__: 'false',
    __HB_OTEL_ENDPOINT__: JSON.stringify(''),
  },

  plugins: [WxtVitest()],

  // If any dependencies rely on webextension-polyfill, add them here to the `ssr.noExternal` option.
  // Example:
  // ssr: {
  //   noExternal: ['@webext-core/storage'],
  // },
});
