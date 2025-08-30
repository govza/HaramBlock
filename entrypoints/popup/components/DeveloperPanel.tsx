import { useState, useEffect } from 'react';

import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { type IImagePrediction } from '@/utils/types';

interface PredictionStats {
  totalPredictions: number;
  medianProcessingTime: number;
  medianFetchTime: number;
  medianBitmapTime: number;
  medianInferenceTime: number;
  totalImages: number;
  averagePredictionsPerImage: number;
}

const calculateMedian = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = values.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1];
    const right = sorted[mid];
    return left !== undefined && right !== undefined ? (left + right) / 2 : 0;
  }
  const middle = sorted[mid];
  return middle !== undefined ? middle : 0;
};

const calculateStats = (predictions: IImagePrediction[]): PredictionStats => {
  if (predictions.length === 0) {
    return {
      totalPredictions: 0,
      medianProcessingTime: 0,
      medianFetchTime: 0,
      medianBitmapTime: 0,
      medianInferenceTime: 0,
      totalImages: 0,
      averagePredictionsPerImage: 0,
    };
  }

  const totalImages = predictions.length;
  const totalPredictions = predictions.reduce((sum, pred) => sum + pred.predictions.length, 0);

  const fetchTimes = predictions.map(pred => pred.processingTime.fetchTime);
  const bitmapTimes = predictions.map(pred => pred.processingTime.bitmapTime);
  const inferenceTimes = predictions.map(pred => pred.processingTime.inferenceTime);
  const totalProcessingTimes = predictions.map(
    pred => pred.processingTime.fetchTime + pred.processingTime.bitmapTime + pred.processingTime.inferenceTime,
  );

  return {
    totalPredictions,
    medianProcessingTime: calculateMedian(totalProcessingTimes),
    medianFetchTime: calculateMedian(fetchTimes),
    medianBitmapTime: calculateMedian(bitmapTimes),
    medianInferenceTime: calculateMedian(inferenceTimes),
    totalImages,
    averagePredictionsPerImage: totalImages > 0 ? totalPredictions / totalImages : 0,
  };
};

export const DeveloperPanel = () => {
  const { currentHostname, predictionCacheRepository } = useHostDataContext();
  const [stats, setStats] = useState<PredictionStats | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);

  // Only show in development mode
  if (!import.meta.env.DEV) {
    return null;
  }

  useEffect(() => {
    const loadStats = async (showLoading = false) => {
      if (!currentHostname) return;

      if (showLoading) {
        setIsInitialLoading(true);
      }

      try {
        const predictions = await predictionCacheRepository.findValidByHostname(currentHostname);
        const calculatedStats = calculateStats(predictions);
        setStats(calculatedStats);
      } catch (error) {
        console.error('Failed to load prediction stats:', error);
        setStats(null);
      } finally {
        if (showLoading) {
          setIsInitialLoading(false);
        }
      }
    };

    // Initial load with loading state
    void loadStats(true);

    // Set up an interval to refresh stats periodically without loading state
    const intervalId = setInterval(() => {
      void loadStats(false);
    }, 2000); // Refresh every 2 seconds

    return () => clearInterval(intervalId);
  }, [currentHostname, predictionCacheRepository]);

  if (!stats && !isInitialLoading) return null;

  return (
    <div className='border-t border-gray-600 bg-gray-800 text-gray-300 px-3 py-2'>
      <div className='text-sm font-mono mb-2'>📊 Developer Stats</div>

      <div className='text-xs font-mono space-y-1'>
        {isInitialLoading && <div className='text-gray-400'>Loading stats...</div>}
        {!isInitialLoading && stats && (
          <>
            <div className='text-gray-400 mb-2'>Cache Stats for: {currentHostname}</div>
            <div className='grid grid-cols-2 gap-x-4 gap-y-1'>
              <div>
                Images: <span className='text-white'>{stats.totalImages}</span>
              </div>
              <div>
                Predictions: <span className='text-white'>{stats.totalPredictions}</span>
              </div>
              <div>
                Avg/Image: <span className='text-white'>{stats.averagePredictionsPerImage.toFixed(1)}</span>
              </div>
              <div></div>
            </div>

            <div className='text-gray-400 mt-3 mb-1'>Median Timing (ms):</div>
            <div className='grid grid-cols-2 gap-x-4 gap-y-1'>
              <div>
                Total: <span className='text-white'>{Math.round(stats.medianProcessingTime)}</span>
              </div>
              <div>
                Fetch: <span className='text-white'>{Math.round(stats.medianFetchTime)}</span>
              </div>
              <div>
                Bitmap: <span className='text-white'>{Math.round(stats.medianBitmapTime)}</span>
              </div>
              <div>
                Inference: <span className='text-white'>{Math.round(stats.medianInferenceTime)}</span>
              </div>
            </div>
          </>
        )}
        {!isInitialLoading && !stats && <div className='text-gray-400'>No prediction data available</div>}
      </div>
    </div>
  );
};
