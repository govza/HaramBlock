import { useEffect, useState } from 'react';

import { getVideoProcessingAvailable } from '@/utils/capabilities/videoProcessing';
import { IS_CHROME } from '@/utils/constants/environment';

/**
 * Starts pessimistic on Firefox so the video control never flashes on Android
 * (Firefox for Android has video processing withdrawn - ADR 0003); the cached
 * flag flips it on for desktop within milliseconds.
 */
export const useVideoProcessingAvailable = (): boolean => {
  const [available, setAvailable] = useState(IS_CHROME);

  useEffect(() => {
    void getVideoProcessingAvailable().then(setAvailable);
  }, []);

  return available;
};
