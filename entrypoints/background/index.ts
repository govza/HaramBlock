
import { onMessage } from 'webext-bridge/background';
import type { HostSettingsResponse } from 'webext-bridge';
import { HostSettings } from '@/utils/db/hostSettings';

export default defineBackground(() => {
  onMessage('GET_HOST_SETTINGS_FROM_DB', async (message): Promise<HostSettingsResponse> => {
    const hostname = message?.data?.toString();
    return await HostSettings.load(hostname);
  });
});
