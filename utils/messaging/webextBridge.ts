import type { IHostSettings } from '../db/hostSettings';
import type { ProtocolWithReturn } from 'webext-bridge';

/**
 * Protocol for the bridge to communicate between different parts of the extension
 */
declare module 'webext-bridge' {
  // HostSettings
  export type HostSettingsRequest = string; // hostname
  export type HostSettingsResponse = IHostSettings; // settings

  // Icon update request
  export type IconUpdateRequest = {
    hostname: string;
  };

  export interface ProtocolMap {
    // Retrieve host settings (uses IndexedDB)
    GET_HOST_SETTINGS: ProtocolWithReturn<HostSettingsRequest, HostSettingsResponse>;
    
    // Update icon for hostname
    UPDATE_ICON: ProtocolWithReturn<IconUpdateRequest, void>;
  }
}
