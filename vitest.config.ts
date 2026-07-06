import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

export default defineConfig({
  test: {
    mockReset: true,
    restoreMocks: true,
    watch: false,
    // .claude/** keeps runs in the main checkout from globbing into git worktrees
    exclude: ['tests/e2e/**', 'node_modules/**', '.claude/**'],
  },

  plugins: [WxtVitest()],

  // If any dependencies rely on webextension-polyfill, add them here to the `ssr.noExternal` option.
  // Example:
  // ssr: {
  //   noExternal: ['@webext-core/storage'],
  // },
});
