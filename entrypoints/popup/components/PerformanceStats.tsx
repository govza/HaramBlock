import { useState, useEffect } from 'react';

import { CopyLogsButton } from '@/entrypoints/popup/components/footer/CopyLogsButton';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';
import { type LatencySnapshot } from '@/utils/inference/shared/latencyTracker';
import { backgroundRpc } from '@/utils/messaging/popup';
import { type IImagePrediction } from '@/utils/types';

interface PredictionStats {
  totalImages: number;
  totalDetections: number;
  medianDelay: number;
  throughput: number;
  medianInference: number;
  avgBatchSize: number;
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
      avgBatchSize: 0,
    };
  }

  const totalImages = predictions.length;
  const totalDetections = predictions.reduce((sum, pred) => sum + pred.predictions.length, 0);

  const e2eTimes = predictions.map(pred => pred.processingTime.e2eTime);
  const inferenceTimes = predictions.map(pred => pred.processingTime.inferenceTime);

  const totalInferenceMs = inferenceTimes.reduce((sum, t) => sum + t, 0);
  const throughput = totalInferenceMs > 0 ? (totalImages / totalInferenceMs) * 1000 : 0;

  const batchSizes = predictions
    .map(pred => pred.processingTime.batchSize)
    .filter((b): b is number => typeof b === 'number');
  const avgBatchSize = batchSizes.length > 0 ? batchSizes.reduce((sum, b) => sum + b, 0) / batchSizes.length : 0;

  return {
    totalImages,
    totalDetections,
    medianDelay: calculateMedian(e2eTimes),
    throughput,
    medianInference: calculateMedian(inferenceTimes),
    avgBatchSize,
  };
};

interface PerformanceStatsProps {
  isActive: boolean;
}

export const PerformanceStats = ({ isActive }: PerformanceStatsProps) => {
  const { currentHostname, imageCacheRepository, isGlobalMode } = useHostDataContext();
  const [stats, setStats] = useState<PredictionStats | null>(null);
  const [liveLatency, setLiveLatency] = useState<LatencySnapshot | null>(null);
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
      }

      // Live p75 of pure session.run time from the latency tracker (null until the first
      // post-warmup samples exist in this service-worker session).
      try {
        setLiveLatency(await backgroundRpc.getInferenceLatency());
      } catch {
        setLiveLatency(null);
      }

      if (showLoading) {
        setIsInitialLoading(false);
      }
    };

    void loadStats(true);

    const intervalId = setInterval(() => {
      void loadStats(false);
    }, 2000);

    return () => clearInterval(intervalId);
  }, [currentHostname, imageCacheRepository, isGlobalMode, isActive]);

  return (
    <div>
      <div className='flex items-center justify-between mb-2'>
        <div className='text-sm font-mono'>📊 {t('PerformanceStats.title')}</div>
        <div className='flex items-center gap-1'>
          <CopyLogsButton />
        </div>
      </div>

      <div className='font-mono'>
        {isInitialLoading && <div className='text-gray-400'>{t('PerformanceStats.loading')}</div>}
        {!isInitialLoading && stats && (
          <div className='grid grid-cols-[auto_auto_auto_auto] gap-x-3 gap-y-1'>
            <span className='text-gray-400'>
              {t('PerformanceStats.detections')}
              {'\t'}
            </span>
            <span className='text-white'>
              {stats.totalDetections} <span className='text-gray-400'>{t('PerformanceStats.on')}</span>{' '}
              {stats.totalImages}
              {'\t'}
            </span>
            <span className='text-gray-400'>
              {t('PerformanceStats.inference')}
              {'\t'}
            </span>
            <span className='text-white'>
              {Math.round(stats.medianInference)}
              <span className='text-gray-400'>ms</span>
              {'\n'}
            </span>

            <span className='text-gray-400'>
              {t('PerformanceStats.throughput')}
              {'\t'}
            </span>
            <span className='text-white'>
              {stats.throughput.toFixed(1)}
              <span className='text-gray-400'>/s</span>
              {'\t'}
            </span>
            <span className='text-gray-400'>
              {t('PerformanceStats.e2e')}
              {'\t'}
            </span>
            <span className='text-white'>
              {Math.round(stats.medianDelay)}
              <span className='text-gray-400'>ms</span>
              {'\n'}
            </span>

            <span className='text-gray-400'>
              {t('PerformanceStats.batch')}
              {'\t'}
            </span>
            <span className='text-white'>
              {stats.avgBatchSize.toFixed(1)}
              <span className='text-gray-400'>{t('PerformanceStats.avg')}</span>
              {'\t'}
            </span>

            <span className='text-gray-400'>
              {t('PerformanceStats.latency')}
              {'\t'}
            </span>
            <span className='text-white'>
              {liveLatency ? Math.round(liveLatency.p75Ms) : 0}
              <span className='text-gray-400'>ms</span>
            </span>
          </div>
        )}
        {!isInitialLoading && !stats && <div className='text-gray-400'>{t('Common.noData')}</div>}
      </div>
    </div>
  );
};
