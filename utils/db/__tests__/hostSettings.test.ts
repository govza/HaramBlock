import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { HostSettings, defaultHostSettings, defaultGlobalKey, type IHostSettings } from "@/utils/db/hostSettings";

// Mock the database
vi.mock("@/utils/db/db", () => ({
  hostSettingsDb: {
    hostSettings: {
      put: vi.fn(),
      get: vi.fn(),
    },
  },
}));

// Mock the hostnameUtil module
vi.mock("@/utils/db/hostnameUtil", () => ({
  getEffectiveHostname: vi.fn(),
  isGlobalPage: vi.fn(),
}));

const { hostSettingsDb } = await import("@/utils/db/db");
const { getEffectiveHostname, isGlobalPage } = await import("@/utils/db/hostnameUtil");
const mockPut = vi.mocked(hostSettingsDb.hostSettings.put);
const mockGet = vi.mocked(hostSettingsDb.hostSettings.get);
const mockGetEffectiveHostname = vi.mocked(getEffectiveHostname);
const mockIsGlobalPage = vi.mocked(isGlobalPage);

// Test fixtures
const TEST_HOSTNAME = "example.com";
const STANDARD_SETTINGS: IHostSettings = {
  hostname: TEST_HOSTNAME,
  isGlobal: false,
  masks: ["blur"],
  outline: "bbox",
  policy: "whitelist",
  strictness: 0.8,
};

const GLOBAL_SETTINGS: IHostSettings = {
  hostname: defaultGlobalKey,
  isGlobal: true,
  masks: ["blur"],
  outline: "segment",
  policy: "process",
  strictness: 0.8,
};

describe("HostSettings Class", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up default mocks
    mockGetEffectiveHostname.mockImplementation((hostname) => hostname || defaultGlobalKey);
    mockIsGlobalPage.mockImplementation((hostname) => hostname === defaultGlobalKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Focus on the most complex business logic
  describe("togglePolicy", () => {
    it("should cycle through policies correctly", async () => {
      const hostSettings = new HostSettings(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);

      // Test the policy cycle: whitelist -> blacklist -> process -> whitelist
      await hostSettings.togglePolicy();
      expect(hostSettings.policy).toBe("blacklist");

      await hostSettings.togglePolicy();
      expect(hostSettings.policy).toBe("process");

      await hostSettings.togglePolicy();
      expect(hostSettings.policy).toBe("whitelist");
    });

    it("should handle database errors", async () => {
      const hostSettings = new HostSettings(STANDARD_SETTINGS);
      mockPut.mockRejectedValue(new Error("Database error"));

      await expect(hostSettings.togglePolicy()).rejects.toThrow("Failed to save host settings");
    });
  });

  describe("setStrictness", () => {
    it("should clamp strictness values to valid range", async () => {
      const hostSettings = new HostSettings(STANDARD_SETTINGS);
      mockPut.mockResolvedValue(TEST_HOSTNAME);

      // Test clamping to valid range [0, 1]
      await hostSettings.setStrictness(-0.1);
      expect(hostSettings.strictness).toBe(0);

      await hostSettings.setStrictness(1.2);
      expect(hostSettings.strictness).toBe(1);

      await hostSettings.setStrictness(0.5);
      expect(hostSettings.strictness).toBe(0.5);
    });
  });

  describe("findByHostname (static method)", () => {
    it("should load existing settings from database", async () => {
      const storedSettings = { ...STANDARD_SETTINGS, policy: "blacklist" as const };
      mockGet.mockResolvedValue(storedSettings);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);

      const hostSettings = await HostSettings.findByHostname(TEST_HOSTNAME);
      expect(hostSettings.policy).toBe("blacklist");
      expect(mockGet).toHaveBeenCalledWith(TEST_HOSTNAME);
    });

    it("should handle global pages correctly", async () => {
      mockGet.mockResolvedValue(GLOBAL_SETTINGS);
      mockGetEffectiveHostname.mockReturnValue(defaultGlobalKey);
      mockIsGlobalPage.mockReturnValue(true);
      
      const hostSettings = await HostSettings.findByHostname('chrome://newtab');
      expect(mockGet).toHaveBeenCalledWith(defaultGlobalKey);
      expect(hostSettings.isGlobal).toBe(true);
    });
  });

  describe("static create method", () => {
    it("should initialize with defaults and save new settings", async () => {
      mockPut.mockResolvedValue(TEST_HOSTNAME);
      mockGetEffectiveHostname.mockReturnValue(TEST_HOSTNAME);
      mockIsGlobalPage.mockReturnValue(false);
      
      await HostSettings.create({ hostname: TEST_HOSTNAME });
      
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        hostname: TEST_HOSTNAME,
        policy: defaultHostSettings.policy
      }));
    });
  });
});