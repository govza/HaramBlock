import { injectBackgroundRpc, InjectAdapter } from '@/utils/messaging';

/**
 * Singleton BackgroundRpc proxy for popup
 */
export const backgroundRpc = injectBackgroundRpc(new InjectAdapter('popup'));
