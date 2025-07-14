import type { IHostSettings } from '../db/hostSettings';
import type { ProtocolWithReturn } from 'webext-bridge';

/**
 * Protocol for the bridge to communicate between different parts of the extension
 */
declare module 'webext-bridge' {
  // HostSettings
  export type HostSettingsRequest = string; // hostname
  export type HostSettingsResponse = IHostSettings; // settings

  export interface ProtocolMap {
    // Retrieve host settings (uses IndexedDB)
    GET_HOST_SETTINGS: ProtocolWithReturn<HostSettingsRequest, HostSettingsResponse>;
  }
}
