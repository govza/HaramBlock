import { useState, useEffect } from 'react';

import { CopyLogsButton } from '@/entrypoints/popup/components/footer/CopyLogsButton';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { type IImagePrediction } from '@/utils/types';

interface PredictionStats {
  totalImages: number;
  totalDetections: number;
  medianDelay: number;
  throughput: number;
  medianInference: number;
}

const calculateMedian = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
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
      totalImages: 0,
      totalDetections: 0,
      medianDelay: 0,
      throughput: 0,
      medianInference: 0,
    };
  }

  const totalImages = predictions.length;
  const totalDetections = predictions.reduce((sum, pred) => sum + pred.predictions.length, 0);

  const e2eTimes = predictions.map(pred => pred.processingTime.e2eTime);
  const inferenceTimes = predictions.map(pred => pred.processingTime.inferenceTime);

  const totalInferenceMs = inferenceTimes.reduce((sum, t) => sum + t, 0);
  const throughput = totalInferenceMs > 0 ? (totalImages / totalInferenceMs) * 1000 : 0;

  return {
    totalImages,
    totalDetections,
    medianDelay: calculateMedian(e2eTimes),
    throughput,
    medianInference: calculateMedian(inferenceTimes),
  };
};

interface PerformanceStatsProps {
  isActive: boolean;
}

export const PerformanceStats = ({ isActive }: PerformanceStatsProps) => {
  const { currentHostname, imageCacheRepository, isGlobalMode } = useHostDataContext();
  const [stats, setStats] = useState<PredictionStats | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);

  useEffect(() => {
    if (!isActive) return;

    const loadStats = async (showLoading = false) => {
      if (!currentHostname && !isGlobalMode) return;

      if (showLoading) {
        setIsInitialLoading(true);
      }

      try {
        const predictions = isGlobalMode
          ? await imageCacheRepository.findAllValid()
          : await imageCacheRepository.findValidByHostname(currentHostname);
        const calculatedStats = calculateStats(predictions);
        setStats(calculatedStats);
      } catch {
        setStats(null);
      } finally {
        if (showLoading) {
          setIsInitialLoading(false);
        }
      }
    };

    void loadStats(true);

    const intervalId = setInterval(() => {
      void loadStats(false);
    }, 2000);

    return () => clearInterval(intervalId);
  }, [currentHostname, imageCacheRepository, isGlobalMode, isActive]);

  return (
    <div className='mt-3 pt-2 border-t border-gray-700'>
      <div className='flex items-center justify-between mb-2'>
        <div className='text-sm font-mono'>📊 Performance Statistics</div>
        <CopyLogsButton />
      </div>

      <div className='font-mono'>
        {isInitialLoading && <div className='text-gray-400'>Loading stats...</div>}
        {!isInitialLoading && stats && (
          <div className='grid grid-cols-[auto_auto_auto_auto] gap-x-3 gap-y-1'>
            <span className='text-gray-400'>Detections</span>
            <span className='text-white'>
              {stats.totalDetections} <span className='text-gray-400'>on</span> {stats.totalImages}
            </span>
            <span className='text-gray-400'>Inference</span>
            <span className='text-white'>
              {Math.round(stats.medianInference)}
              <span className='text-gray-400'>ms</span>
            </span>

            <span className='text-gray-400'>Throughput</span>
            <span className='text-white'>
              {stats.throughput.toFixed(1)}
              <span className='text-gray-400'>/s</span>
            </span>
            <span className='text-gray-400'>E2E</span>
            <span className='text-white'>
              {Math.round(stats.medianDelay)}
              <span className='text-gray-400'>ms</span>
            </span>
          </div>
        )}
        {!isInitialLoading && !stats && <div className='text-gray-400'>No data</div>}
      </div>
    </div>
  );
};
