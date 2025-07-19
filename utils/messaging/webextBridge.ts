import type { IHostSettings } from '../db/hostSettings';
import type { ProtocolWithReturn } from 'webext-bridge';

/**
 * Protocol for the bridge to communicate between different parts of the extension
 */
declare module 'webext-bridge' {
  // HostSettings
  export type HostSettingsRequest = string; // hostname
  export type HostSettingsResponse = IHostSettings; // settings

  // Hostname change notification (used for icon updates and settings change notifications)
  export type HostnameChangeRequest = {
    hostname: string;
  };

  export interface ProtocolMap {
    // Retrieve host settings (uses IndexedDB)
    GET_HOST_SETTINGS: ProtocolWithReturn<HostSettingsRequest, HostSettingsResponse>;
    
    // Update icon for hostname
    UPDATE_ICON: ProtocolWithReturn<HostnameChangeRequest, void>;
    
    // Notify content scripts of settings changes
    HOST_SETTINGS_UPDATED: ProtocolWithReturn<HostnameChangeRequest, void>;
  }
}
