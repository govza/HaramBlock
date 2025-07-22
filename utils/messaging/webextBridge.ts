import type { IHostSettings } from '../db/hostSettings';
import type { ProtocolWithReturn } from 'webext-bridge';

/**
 * Protocol for the bridge to communicate between different parts of the extension
 */
declare module 'webext-bridge' {
  export interface ProtocolMap {
    // Retrieve host settings (uses IndexedDB)
    GET_HOST_SETTINGS: ProtocolWithReturn<{ hostname: string }, IHostSettings>;

    // Update icon for hostname
    UPDATE_ICON: ProtocolWithReturn<{ hostname: string }, void>;

    // Notify content scripts of settings changes
    HOST_SETTINGS_UPDATED: ProtocolWithReturn<{ hostname: string }, void>;
  }
}
