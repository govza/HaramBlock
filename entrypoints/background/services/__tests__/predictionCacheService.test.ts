import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';

import { PredictionCacheService } from '@/entrypoints/background/services/predictionCacheService';
import { PredictionCache } from '@/utils/db/predictionCache';
import { type IImagePrediction } from '@/utils/types';

// Mock the PredictionCache class
vi.mock('@/utils/db/predictionCache', () => ({
  PredictionCache: {
    findValidByHostname: vi.fn(),
  },
}));

// Mock the logger
vi.mock('@/utils/logger', () => ({
  logger: {
    withTag: vi.fn().mockReturnThis(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

 
const mockFindValidByHostname =
  PredictionCache.findValidByHostname as ReturnType<typeof vi.fn>;

// Import mocked logger
const { logger } = await import('@/utils/logger');
const mockLogger = vi.mocked(logger);

// Test fixtures
const TEST_HOSTNAME = 'example.com';

interface MockPredictionCache {
  serialize: Mock;
  updateAccessTime: Mock;
  save: Mock;
  delete: Mock;
  isValid: Mock;
  getRemainingTTL: Mock;
  src: string;
  hostname: string;
  imageWidth: number;
  imageHeight: number;
  predictions: IImagePrediction['predictions'];
  timestamp: number;
  cacheMetadata: IImagePrediction['cacheMetadata'];
}

const createMockPredictionCache = (
  overrides: Partial<IImagePrediction> = {},
): MockPredictionCache => {
  const baseData: IImagePrediction = {
    hostname: TEST_HOSTNAME,
    src: 'https://example.com/image1.jpg',
    imageWidth: 800,
    imageHeight: 600,
    predictions: [
      {
        classId: 1,
        className: 'person',
        probability: 0.95,
        boundingBox: { x: 100, y: 100, width: 200, height: 300 },
        polygon: [
          { x: 100, y: 100 },
          { x: 300, y: 100 },
          { x: 300, y: 400 },
          { x: 100, y: 400 },
        ],
      },
    ],
    timestamp: Date.now() - 1000,
    cacheMetadata: {
      createdAt: Date.now() - 1000,
      accessedAt: Date.now() - 1000,
      maxAge: 3600,
      cacheControl: 'max-age=3600',
    },
    ...overrides,
  };

  return {
    serialize: vi.fn().mockReturnValue(baseData),
    updateAccessTime: vi.fn(),
    save: vi.fn().mockResolvedValue('saved-id'),
    delete: vi.fn().mockResolvedValue(undefined),
    isValid: vi.fn().mockReturnValue(true),
    getRemainingTTL: vi.fn().mockReturnValue(3600),
    ...baseData,
  };
};

describe('PredictionCacheService', () => {
  let service: PredictionCacheService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PredictionCacheService();

    // Ensure the mock has a default return value to prevent undefined errors
    mockFindValidByHostname.mockResolvedValue([]);

    // Reset logger mocks
    mockLogger.withTag.mockReturnThis();
    mockLogger.warn.mockImplementation(() => {});
    mockLogger.error.mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getCachedPredictionsByHostname', () => {
    describe('Complex Business Logic', () => {
      it('should handle multiple predictions with mixed validity states', async () => {
        // Setup: Mix of valid and invalid predictions (but findValidByHostname should only return valid ones)
        const validPrediction1 = createMockPredictionCache({
          src: 'https://example.com/valid1.jpg',
          timestamp: Date.now() - 500,
        });
        const validPrediction2 = createMockPredictionCache({
          src: 'https://example.com/valid2.jpg',
          timestamp: Date.now() - 1500,
        });

        mockFindValidByHostname.mockResolvedValue([
          validPrediction1,
          validPrediction2,
        ]);

        const result =
          await service.getCachedPredictionsByHostname(TEST_HOSTNAME);

        // Should return serialized data from both valid predictions
        expect(result).toHaveLength(2);
        expect(validPrediction1.serialize).toHaveBeenCalled();
        expect(validPrediction2.serialize).toHaveBeenCalled();
        expect(mockFindValidByHostname).toHaveBeenCalledWith(TEST_HOSTNAME);
      });

      it('should update access times asynchronously without blocking response', async () => {
        const prediction1 = createMockPredictionCache();
        const prediction2 = createMockPredictionCache({
          src: 'https://example.com/image2.jpg',
        });

        // Make save operations slow to test async behavior
        prediction1.save.mockImplementation(
          () => new Promise(resolve => setTimeout(resolve, 100)),
        );
        prediction2.save.mockImplementation(
          () => new Promise(resolve => setTimeout(resolve, 100)),
        );

        mockFindValidByHostname.mockResolvedValue([prediction1, prediction2]);

        const startTime = Date.now();
        const result =
          await service.getCachedPredictionsByHostname(TEST_HOSTNAME);
        const responseTime = Date.now() - startTime;

        // Response should be fast (not waiting for save operations)
        expect(responseTime).toBeLessThan(50);
        expect(result).toHaveLength(2);

        // Access times should be updated (called synchronously before save)
        expect(prediction1.updateAccessTime).toHaveBeenCalled();
        expect(prediction2.updateAccessTime).toHaveBeenCalled();

        // Wait a bit and verify saves were attempted in background
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(prediction1.save).toHaveBeenCalled();
        expect(prediction2.save).toHaveBeenCalled();
      });

      it('should handle background save failures gracefully without affecting response', async () => {
        const prediction = createMockPredictionCache();
        prediction.save.mockRejectedValue(
          new Error('Database connection failed'),
        );

        mockFindValidByHostname.mockResolvedValue([prediction]);

        // Should not throw despite save failure
        const result =
          await service.getCachedPredictionsByHostname(TEST_HOSTNAME);

        expect(result).toHaveLength(1);
        expect(prediction.updateAccessTime).toHaveBeenCalled();

        // Wait for background operation to complete
        await new Promise(resolve => setTimeout(resolve, 10));

        // Should have logged warning but not thrown
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Failed to update access time for prediction:',
          prediction.src,
          expect.any(Error),
        );
      });

      it('should handle mixed success/failure in background save operations', async () => {
        const successPrediction = createMockPredictionCache({
          src: 'success.jpg',
        });
        const failPrediction = createMockPredictionCache({ src: 'fail.jpg' });

        successPrediction.save.mockResolvedValue('success-id');
        failPrediction.save.mockRejectedValue(new Error('Save failed'));

        mockFindValidByHostname.mockResolvedValue([
          successPrediction,
          failPrediction,
        ]);

        const result =
          await service.getCachedPredictionsByHostname(TEST_HOSTNAME);

        expect(result).toHaveLength(2);

        // Wait for background operations
        await new Promise(resolve => setTimeout(resolve, 10));

        // Success case should not log warnings
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Failed to update access time for prediction:',
          'fail.jpg',
          expect.any(Error),
        );
      });

      it('should optimize for empty result sets', async () => {
        mockFindValidByHostname.mockResolvedValue([]);

        const result =
          await service.getCachedPredictionsByHostname(TEST_HOSTNAME);

        expect(result).toEqual([]);
        expect(mockFindValidByHostname).toHaveBeenCalledWith(TEST_HOSTNAME);
        // No background operations should be triggered for empty results
      });

      it('should handle large datasets efficiently', async () => {
        // Create a large number of mock predictions
        const largePredictionSet = Array.from({ length: 100 }, (_, index) =>
          createMockPredictionCache({
            src: `https://example.com/image${index}.jpg`,
            timestamp: Date.now() - index * 1000,
          }),
        );

        mockFindValidByHostname.mockResolvedValue(largePredictionSet);

        const startTime = Date.now();
        const result =
          await service.getCachedPredictionsByHostname(TEST_HOSTNAME);
        const responseTime = Date.now() - startTime;

        expect(result).toHaveLength(100);
        // Should still be reasonably fast even with 100 items
        expect(responseTime).toBeLessThan(100);

        // All predictions should have access time updated
        largePredictionSet.forEach(prediction => {
          expect(prediction.updateAccessTime).toHaveBeenCalled();
        });
      });

      it('should handle database query failures appropriately', async () => {
        const dbError = new Error('Database connection timeout');
        mockFindValidByHostname.mockRejectedValue(dbError);

        await expect(
          service.getCachedPredictionsByHostname(TEST_HOSTNAME),
        ).rejects.toThrow('Database connection timeout');

        expect(mockFindValidByHostname).toHaveBeenCalledWith(TEST_HOSTNAME);
      });

      it('should validate hostname parameter correctly', async () => {
        // Test empty string
        await expect(
          service.getCachedPredictionsByHostname(''),
        ).rejects.toThrow('Hostname is required');

        // Test whitespace string
        await expect(
          service.getCachedPredictionsByHostname('   '),
        ).rejects.toThrow('Hostname is required');

        // Test null (cast to string as the method expects string)
        await expect(
          service.getCachedPredictionsByHostname(null as unknown as string),
        ).rejects.toThrow('Hostname is required');

        // Test undefined (cast to string as the method expects string)
        await expect(
          service.getCachedPredictionsByHostname(
            undefined as unknown as string,
          ),
        ).rejects.toThrow('Hostname is required');

        // Should not have called database for invalid hostnames
        expect(mockFindValidByHostname).not.toHaveBeenCalled();
      });

      it('should maintain data integrity during serialization', async () => {
        const originalData: IImagePrediction = {
          hostname: TEST_HOSTNAME,
          src: 'https://example.com/test.jpg',
          imageWidth: 1920,
          imageHeight: 1080,
          predictions: [
            {
              classId: 5,
              className: 'vehicle',
              probability: 0.87,
              boundingBox: { x: 50, y: 75, width: 300, height: 200 },
              polygon: [
                { x: 50, y: 75 },
                { x: 350, y: 75 },
                { x: 350, y: 275 },
                { x: 50, y: 275 },
              ],
            },
          ],
          timestamp: 1642781234567,
          cacheMetadata: {
            createdAt: 1642781234567,
            accessedAt: 1642781234567,
            maxAge: 7200,
            etag: 'abc123',
            cacheControl: 'max-age=7200, must-revalidate',
          },
        };

        const mockPrediction = createMockPredictionCache(originalData);
        mockPrediction.serialize.mockReturnValue(originalData);
        mockFindValidByHostname.mockResolvedValue([mockPrediction]);

        const result =
          await service.getCachedPredictionsByHostname(TEST_HOSTNAME);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(originalData);

        // Type-safe assertions with proper null checks
        const firstResult = result[0];
        const firstPrediction = firstResult?.predictions?.[0];
        expect(firstPrediction?.probability).toBe(0.87);
        expect(firstResult?.cacheMetadata?.etag).toBe('abc123');
      });
    });
  });
});
