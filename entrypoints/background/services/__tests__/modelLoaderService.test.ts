import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ModelLoaderService } from '@/entrypoints/background/services/modelLoaderService';

// Mock TensorFlow.js
vi.mock('@tensorflow/tfjs', () => ({
  loadGraphModel: vi.fn(),
  randomUniform: vi.fn(() => ({
    dispose: vi.fn(),
  })),
  dispose: vi.fn(),
}));

// Mock browser API
const mockBrowser = {
  runtime: {
    getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
  },
};
// @ts-expect-error - Mock implementation for testing - Mocking browser global for tests
globalThis.browser = mockBrowser;

describe('ModelLoaderService', () => {
  let modelLoaderService: ModelLoaderService;

  beforeEach(() => {
    modelLoaderService = new ModelLoaderService();
    vi.clearAllMocks();
  });

  describe('Initial State', () => {
    it('should have correct initial state', () => {
      expect(modelLoaderService.isModelReady()).toBe(false);
      expect(modelLoaderService.getModel()).toBeNull();
    });
  });

  describe('Cleanup', () => {
    it('should handle cleanup when no model is loaded', () => {
      expect(() => modelLoaderService.cleanup()).not.toThrow();
    });
  });
});
