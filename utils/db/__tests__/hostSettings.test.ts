import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { DEFAULT_GLOBAL_KEY, DEFAULT_HOST_SETTINGS } from '@/utils/constants';
import { HostSettingsRepository } from '@/utils/db/hostSettingsRepository';
import { normalizeStoredPolicy } from '@/utils/policy';
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
  isIncognito: false,
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
  masking: { grayscale: false, dark: false, blurIntensity: 50, pixelationScale: 50 },
  outline: 'bbox',
  policy: { behavior: 'whitelist', targets: { image: true, video: false } },
  strictness: 0.8,
  minSize: { width: 64, height: 64 },
  quickToggle: { unsafeEnabled: true, safeEnabled: true },
};

const GLOBAL_SETTINGS: IHostSettings = {
  hostname: DEFAULT_GLOBAL_KEY,
  isGlobal: true,
  masking: { grayscale: false, dark: false, blurIntensity: 50, pixelationScale: 50 },
  outline: 'segment',
  policy: { behavior: 'process', targets: { image: true, video: true } },
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
    it('should cycle through policy behaviors correctly', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      // Cycle: process -> whitelist -> blacklist -> process
      // Starting from whitelist (STANDARD_SETTINGS)
      let settings = await repository.togglePolicy(TEST_HOSTNAME);
      expect(settings.policy.behavior).toBe('blacklist');

      mockGet.mockResolvedValue(settings);
      settings = await repository.togglePolicy(TEST_HOSTNAME);
      expect(settings.policy.behavior).toBe('process');

      mockGet.mockResolvedValue(settings);
      settings = await repository.togglePolicy(TEST_HOSTNAME);
      expect(settings.policy.behavior).toBe('whitelist');
    });

    it('should handle database errors', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockRejectedValue(new Error('Database error'));
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      await expect(repository.togglePolicy(TEST_HOSTNAME)).rejects.toThrow('Failed to save host settings');
    });
  });

  describe('setTarget', () => {
    const PROCESS_SETTINGS: IHostSettings = {
      ...STANDARD_SETTINGS,
      policy: { behavior: 'process', targets: { image: true, video: false } },
    };

    it('should toggle a target while preserving behavior and other targets', async () => {
      mockGet.mockResolvedValue(PROCESS_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const settings = await repository.setTarget(TEST_HOSTNAME, 'video', true);

      expect(settings.policy.targets.video).toBe(true);
      expect(settings.policy.targets.image).toBe(true);
      expect(settings.policy.behavior).toBe('process');
    });

    it('refuses to disable the last enabled target', async () => {
      mockGet.mockResolvedValue(PROCESS_SETTINGS); // image: true, video: false
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const settings = await repository.setTarget(TEST_HOSTNAME, 'image', false);

      expect(settings.policy.targets.image).toBe(true);
      expect(mockPut).not.toHaveBeenCalled();
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
      const storedSettings: IHostSettings = {
        ...STANDARD_SETTINGS,
        policy: { behavior: 'blacklist', targets: { image: true, video: false } },
      };
      mockGet.mockResolvedValue(storedSettings);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const hostSettings = await repository.findByHostname(TEST_HOSTNAME);
      expect(hostSettings.policy.behavior).toBe('blacklist');
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
      expect(hostSettings.policy).toEqual(DEFAULT_HOST_SETTINGS.policy);
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
        masking: { grayscale: false, dark: false, blurIntensity: 50, pixelationScale: 50 },
        outline: 'bbox',
        policy: { behavior: 'whitelist', targets: { image: true, video: false } },
        strictness: 0,
        minSize: { width: 64, height: 64 },
        quickToggle: { unsafeEnabled: true, safeEnabled: false },
      });

      expect(mockAdd).toHaveBeenCalledWith({
        hostname: TEST_HOSTNAME,
        isGlobal: false,
        masking: { grayscale: false, dark: false, blurIntensity: 50, pixelationScale: 50 },
        outline: 'bbox',
        policy: { behavior: 'whitelist', targets: { image: true, video: false } },
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

  describe('setGrayscale', () => {
    it('should update grayscale while preserving other masking settings', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const settings = await repository.setGrayscale(TEST_HOSTNAME, true);

      expect(settings.masking.grayscale).toBe(true);
      expect(settings.masking.dark).toBe(false);
      expect(settings.masking.blurIntensity).toBe(50);
      expect(settings.masking.pixelationScale).toBe(50);
    });
  });

  describe('setDark', () => {
    it('should update dark while preserving other masking settings', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const settings = await repository.setDark(TEST_HOSTNAME, true);

      expect(settings.masking.dark).toBe(true);
      expect(settings.masking.grayscale).toBe(false);
      expect(settings.masking.blurIntensity).toBe(50);
      expect(settings.masking.pixelationScale).toBe(50);
    });
  });

  describe('setBlurIntensity', () => {
    it('should update blurIntensity while preserving other masking settings', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const settings = await repository.setBlurIntensity(TEST_HOSTNAME, 75);

      expect(settings.masking.blurIntensity).toBe(75);
      expect(settings.masking.grayscale).toBe(false);
      expect(settings.masking.dark).toBe(false);
      expect(settings.masking.pixelationScale).toBe(50);
    });

    it('should clamp blurIntensity to valid range [1, 100]', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      let settings = await repository.setBlurIntensity(TEST_HOSTNAME, 0);
      expect(settings.masking.blurIntensity).toBe(1);

      settings = await repository.setBlurIntensity(TEST_HOSTNAME, 150);
      expect(settings.masking.blurIntensity).toBe(100);
    });
  });

  describe('setPixelationScale', () => {
    it('should update pixelationScale while preserving other masking settings', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const settings = await repository.setPixelationScale(TEST_HOSTNAME, 80);

      expect(settings.masking.pixelationScale).toBe(80);
      expect(settings.masking.grayscale).toBe(false);
      expect(settings.masking.dark).toBe(false);
      expect(settings.masking.blurIntensity).toBe(50);
    });

    it('should clamp pixelationScale to valid range [1, 100]', async () => {
      mockGet.mockResolvedValue(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      let settings = await repository.setPixelationScale(TEST_HOSTNAME, -10);
      expect(settings.masking.pixelationScale).toBe(1);

      settings = await repository.setPixelationScale(TEST_HOSTNAME, 200);
      expect(settings.masking.pixelationScale).toBe(100);
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

describe('normalizeStoredPolicy', () => {
  it('maps legacy process-images to process with video off', () => {
    expect(normalizeStoredPolicy('process-images')).toEqual({
      behavior: 'process',
      targets: { image: true, video: false },
    });
  });

  it('maps legacy process (process all) to all targets enabled', () => {
    expect(normalizeStoredPolicy('process')).toEqual({
      behavior: 'process',
      targets: { image: true, video: true },
    });
  });

  it('preserves stored targets across non-process behaviors', () => {
    expect(normalizeStoredPolicy({ behavior: 'whitelist', targets: { image: true, video: false } })).toEqual({
      behavior: 'whitelist',
      targets: { image: true, video: false },
    });
  });

  it('backfills missing targets on a process policy from defaults', () => {
    expect(normalizeStoredPolicy({ behavior: 'process', targets: { video: true } })).toEqual({
      behavior: 'process',
      targets: { image: true, video: true },
    });
  });

  it('falls back to the default policy for unknown values', () => {
    expect(normalizeStoredPolicy(undefined)).toEqual(DEFAULT_HOST_SETTINGS.policy);
  });
});
