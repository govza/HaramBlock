import { injectBackgroundRpc, InjectAdapter } from '@/utils/messaging';

/**
 * Singleton BackgroundRpc proxy for content scripts
 */
export const backgroundRpc = injectBackgroundRpc(new InjectAdapter('content'));
