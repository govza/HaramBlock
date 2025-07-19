import { sendMessage, onMessage } from "webext-bridge/content-script";
import { initialHideImagesStyle } from "./masking/hide";
import { getEffectiveHostname } from '@/utils/db/hostnameUtil';
import { IHostSettings } from '@/utils/db/hostSettings';

export default defineContentScript({
  matches: ['<all_urls>'],
  async main() {
    // Prevents cached images from being displayed before DOMContentLoaded
    const hideInitStyle = initialHideImagesStyle();

    const currentHostname = window.location.hostname;
    const effectiveHostname = getEffectiveHostname(currentHostname);
    let settings: IHostSettings | undefined;

    try {
      const hostSettings = await sendMessage('GET_HOST_SETTINGS', currentHostname, 'background');
      settings = hostSettings;
      console.log('seetings:', settings)
    } catch (error) {
      console.error('Error fetching host settings:', error);
    }

    hideInitStyle.remove();

    // Listen for settings updates from popup
    onMessage('HOST_SETTINGS_UPDATED', async (message) => {
      const { hostname } = message.data;
      
      // Check if this message is for our hostname
      if (getEffectiveHostname(hostname) === effectiveHostname) {
        console.log('Received settings update notification for:', hostname);
        
        // Retrieve the updated settings
        try {
          const updatedSettings = await sendMessage('GET_HOST_SETTINGS', currentHostname, 'background');
          settings = updatedSettings;
          console.log('Updated settings:', settings);
        } catch (error) {
          console.error('Error retrieving updated settings:', error);
        }
      }
    });
  },
});
