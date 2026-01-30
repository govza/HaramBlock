import { useState } from 'react';

import { exportEventsAsJson } from '@/utils/logging';

export const CopyLogsButton = () => {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const handleClick = () => {
    exportEventsAsJson()
      .then(json => navigator.clipboard.writeText(json))
      .then(() => setStatus('copied'))
      .catch(() => setStatus('error'))
      .finally(() => setTimeout(() => setStatus('idle'), 2000));
  };

  const getLabel = () => {
    if (status === 'copied') return '[copied]';
    if (status === 'error') return '[error]';
    return '[logs]';
  };

  const getColorClass = () => {
    if (status === 'copied') return 'text-green-500';
    if (status === 'error') return 'text-red-500';
    return 'text-gray-400 hover:text-white';
  };

  return (
    <button
      className={`cursor-pointer font-mono text-xs ${getColorClass()}`}
      onClick={handleClick}
      title='Copy logs to clipboard'
    >
      {getLabel()}
    </button>
  );
};
