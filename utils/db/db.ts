import Dexie, { type Table } from 'dexie';
import { defaultHostSettings, IHostSettings } from '@/utils/db/HostSettings';

export class HostSettingsDatabase extends Dexie {
    hostSettings!: Table<IHostSettings, string>;

    constructor() {
        super('HostSettingsDatabase');
        this.version(1).stores({
            hostSettings: 'hostname' // Primary key
        });
    }
}

export  const hostSettingsDb = new HostSettingsDatabase();

hostSettingsDb.on('populate', () => {
    // Initialize with default global settings
    hostSettingsDb.hostSettings.add(defaultHostSettings);
});
