import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

export default defineConfig({
  // Configure test behavior however you like
  test: {
    mockReset: true,
    restoreMocks: true,
    watch: false,
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },

  plugins: [WxtVitest()],

  // If any dependencies rely on webextension-polyfill, add them here to the `ssr.noExternal` option.
  // Example:
  // ssr: {
  //   noExternal: ['@webext-core/storage'],
  // },
});
