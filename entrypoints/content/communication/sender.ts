import { sendMessage } from 'webext-bridge/content-script';
import { IHostSettings } from '@/utils/db/hostSettings';
import { IImagePrediction } from '@/utils/db/predictionCache';
import { logger } from '@/utils/logger';

/**
 * Communication sender module for HaramBlock content script
 */

// ============================================================================
// HOST SETTINGS COMMUNICATION
// ============================================================================

/**
 * Request host settings from background script
 * @param hostname - The hostname to get settings for
 * @returns Promise resolving to host settings or undefined
 */
export async function requestHostSettings(hostname: string): Promise<IHostSettings | undefined> {
  try {
    return await sendMessage('GET_HOST_SETTINGS', { hostname }, 'background');
  } catch (error) {
    logger.withTag("Content").error('Failed to request host settings:', error);
    return undefined;
  }
}

// ============================================================================
// PREDICTION CACHE COMMUNICATION
// ============================================================================

/**
 * Request cached predictions for a hostname from background script
 * @param hostname - The hostname to get cached predictions for
 * @returns Promise resolving to array of cached predictions
 */
export async function requestCachedPredictions(hostname: string): Promise<IImagePrediction[]> {
  try {
    const result = await sendMessage('GET_HOSTNAME_IMAGE_PREDICTION_CACHE', { hostname }, 'background');
    return result || [];
  } catch (error) {
    logger.withTag("Content").error('Failed to request cached predictions:', error);
    return [];
  }
}

// ============================================================================
// AI INFERENCE COMMUNICATION
// ============================================================================

/**
 * Queue images for AI processing in background script
 * @param hostname - The hostname for these images
 * @param imageSrcs - Array of image source URLs to process
 * @returns Promise that resolves when images are queued
 */
export async function queueImagesForInference(hostname: string, imageSrcs: string[]): Promise<void> {
  try {
    await sendMessage('POST_INFERENCE_IMAGES', {
      hostname,
      imageSrcs
    }, 'background');
    
  } catch (error) {
    logger.withTag("Content").error('Failed to queue images for inference:', error);
    throw error;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Request both host settings and cached predictions in parallel
 * @param hostname - The hostname to get data for
 * @returns Promise resolving to object with settings and predictions
 */
export async function requestHostData(hostname: string): Promise<{
  settings: IHostSettings | undefined;
  predictions: IImagePrediction[];
}> {
  try {
    const [settings, predictions] = await Promise.all([
      requestHostSettings(hostname),
      requestCachedPredictions(hostname)
    ]);

    return {
      settings,
      predictions
    };
  } catch (error) {
    logger.withTag("Content").error('Failed to request host data:', error);
    return {
      settings: undefined,
      predictions: []
    };
  }
}
