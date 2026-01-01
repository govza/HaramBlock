import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { DEFAULT_GLOBAL_KEY, DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { type IHostSettings } from '@/utils/types';

// Mock the database
vi.mock('@/utils/db/db', () => ({
  hostSettingsDb: {
    hostSettings: {
      put: vi.fn(),
      get: vi.fn(),
      add: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// Mock the hostnameUtil module
vi.mock('@/utils/hostnameUtil', () => ({
  getEffectiveHostname: vi.fn(),
  isGlobalPage: vi.fn(),
}));

const { hostSettingsDb } = await import('@/utils/db/db');
const { getEffectiveHostname, isGlobalPage } = await import('@/utils/hostnameUtil');

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockPut = hostSettingsDb.hostSettings.put as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/unbound-method
const mockGet = hostSettingsDb.hostSettings.get as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/unbound-method
const mockAdd = hostSettingsDb.hostSettings.add as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/unbound-method
const mockDelete = hostSettingsDb.hostSettings.delete as ReturnType<typeof vi.fn>;
const mockGetEffectiveHostname = vi.mocked(getEffectiveHostname);
const mockIsGlobalPage = vi.mocked(isGlobalPage);

// Test fixtures
const TEST_HOSTNAME = 'example.com';
const STANDARD_SETTINGS: IHostSettings = {
  hostname: TEST_HOSTNAME,
  isGlobal: false,
  masking: { blur: true, blurTint: 'none', blurIntensity: 50, pixelationScale: 50 },
  outline: 'bbox',
  policy: 'whitelist',
  strictness: 0.8,
  minSize: { width: 64, height: 64 },
  quickToggle: { unsafeEnabled: true, safeEnabled: true },
};

const GLOBAL_SETTINGS: IHostSettings = {
  hostname: DEFAULT_GLOBAL_KEY,
  isGlobal: true,
  masking: { blur: true, blurTint: 'none', blurIntensity: 50, pixelationScale: 50 },
  outline: 'segment',
  policy: 'process',
  strictness: 0.8,
  minSize: { width: 64, height: 64 },
  quickToggle: { unsafeEnabled: true, safeEnabled: true },
};

describe('HostSettingsRepository', () => {
  let repository: HostSettingsRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new HostSettingsRepository();
    // Set up default mocks
    mockGetEffectiveHostname.mockImplementation(hostname => hostname || DEFAULT_GLOBAL_KEY);
    mockIsGlobalPage.mockImplementation(hostname => hostname === DEFAULT_GLOBAL_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Focus on the most complex business logic
  describe('togglePolicy', () => {
    it('should cycle through policies correctly', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      // Test the policy cycle: whitelist -> blacklist -> process -> whitelist
      let settings = await repository.togglePolicy(TEST_HOSTNAME);
      expect(settings.policy).toBe('blacklist');

      mockGet.mockResolvedValue(settings);
      settings = await repository.togglePolicy(TEST_HOSTNAME);
      expect(settings.policy).toBe('process');

      mockGet.mockResolvedValue(settings);
      settings = await repository.togglePolicy(TEST_HOSTNAME);
      expect(settings.policy).toBe('whitelist');
    });

    it('should handle database errors', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockRejectedValue(new Error('Database error'));
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      await expect(repository.togglePolicy(TEST_HOSTNAME)).rejects.toThrow('Failed to save host settings');
    });
  });

  describe('setStrictness', () => {
    it('should clamp strictness values to valid range', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      // Test clamping to valid range [0, 1]
      let settings = await repository.setStrictness(TEST_HOSTNAME, -0.1);
      expect(settings.strictness).toBe(0);

      settings = await repository.setStrictness(TEST_HOSTNAME, 1.2);
      expect(settings.strictness).toBe(1);

      settings = await repository.setStrictness(TEST_HOSTNAME, 0.5);
      expect(settings.strictness).toBe(0.5);
    });
  });

  describe('findByHostname', () => {
    it('should load existing settings from database', async () => {
      const storedSettings = {
        ...STANDARD_SETTINGS,
        policy: 'blacklist' as const,
      };
      mockGet.mockResolvedValue(storedSettings);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const hostSettings = await repository.findByHostname(TEST_HOSTNAME);
      expect(hostSettings.policy).toBe('blacklist');
      expect(mockGet).toHaveBeenCalledWith(TEST_HOSTNAME);
    });

    it('should handle global pages correctly', async () => {
      mockGet.mockResolvedValue(GLOBAL_SETTINGS);
      mockGetEffectiveHostname.mockReturnValue(DEFAULT_GLOBAL_KEY);
      mockIsGlobalPage.mockReturnValue(true);

      const hostSettings = await repository.findByHostname('chrome://newtab');
      expect(mockGet).toHaveBeenCalledWith(DEFAULT_GLOBAL_KEY);
      expect(hostSettings.isGlobal).toBe(true);
    });

    it('should return defaults when no settings found', async () => {
      mockGet.mockResolvedValue(undefined);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);
      mockIsGlobalPage.mockReturnValue(false);

      const hostSettings = await repository.findByHostname(TEST_HOSTNAME);
      expect(hostSettings.hostname).toBe(TEST_HOSTNAME);
      expect(hostSettings.policy).toBe(DEFAULT_HOST_SETTINGS.policy);
    });
  });

  describe('create method', () => {
    it('should initialize with defaults and save new settings', async () => {
      mockAdd.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);
      mockIsGlobalPage.mockReturnValue(false);

      await repository.create({
        hostname: TEST_HOSTNAME,
        isGlobal: false,
        masking: { blur: false, blurTint: 'none', pixelationScale: 50 },
        outline: 'bbox',
        policy: 'whitelist',
        strictness: 0,
        minSize: { width: 64, height: 64 },
        quickToggle: { unsafeEnabled: true, safeEnabled: false },
      });

      expect(mockAdd).toHaveBeenCalledWith({
        hostname: TEST_HOSTNAME,
        isGlobal: false,
        masking: { blur: false, blurTint: 'none', pixelationScale: 50 },
        outline: 'bbox',
        policy: 'whitelist',
        strictness: 0,
        minSize: { width: 64, height: 64 },
        quickToggle: { unsafeEnabled: true, safeEnabled: false },
      });
    });
  });

  describe('setQuickToggleUnsafe', () => {
    it('should update unsafeEnabled while preserving safeEnabled', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const settings = await repository.setQuickToggleUnsafe(TEST_HOSTNAME, false);

      expect(settings.quickToggle.unsafeEnabled).toBe(false);
      expect(settings.quickToggle.safeEnabled).toBe(true);
    });
  });

  describe('setQuickToggleSafe', () => {
    it('should update safeEnabled while preserving unsafeEnabled', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const settings = await repository.setQuickToggleSafe(TEST_HOSTNAME, true);

      expect(settings.quickToggle.safeEnabled).toBe(true);
      expect(settings.quickToggle.unsafeEnabled).toBe(true);
    });
  });

  describe('delete method', () => {
    it('should delete regular host settings', async () => {
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);
      mockDelete.mockResolvedValue(undefined);

      await repository.delete(TEST_HOSTNAME);

      expect(mockDelete).toHaveBeenCalledWith(TEST_HOSTNAME);
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('should reset global settings instead of deleting', async () => {
      mockGetEffectiveHostname.mockReturnValue(DEFAULT_GLOBAL_KEY);
      mockPut.mockResolvedValue(DEFAULT_GLOBAL_KEY);

      await repository.delete(DEFAULT_GLOBAL_KEY);

      expect(mockPut).toHaveBeenCalledWith(DEFAULT_HOST_SETTINGS);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('should reset global settings for any hostname that maps to global', async () => {
      // Test that chrome:// URLs get mapped to global and reset
      mockGetEffectiveHostname.mockReturnValue(DEFAULT_GLOBAL_KEY);
      mockPut.mockResolvedValue(DEFAULT_GLOBAL_KEY);

      await repository.delete('chrome://newtab');

      expect(mockGetEffectiveHostname).toHaveBeenCalledWith('chrome://newtab');
      expect(mockPut).toHaveBeenCalledWith(DEFAULT_HOST_SETTINGS);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
