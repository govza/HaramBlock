import { installMseHook } from '@/utils/lookahead/mseHook';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    installMseHook(globalThis.window);
  },
});
