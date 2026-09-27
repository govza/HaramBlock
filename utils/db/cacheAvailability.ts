import { isIncognito } from '@/utils/db/db';

export const isCacheDisabled = isIncognito || import.meta.env.MODE === 'no-cache';
