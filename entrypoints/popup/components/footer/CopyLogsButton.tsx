import { useState } from 'react';

import { t } from '@/utils/i18n';
import { backgroundRpc } from '@/utils/messaging/popup';

export const CopyLogsButton = () => {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const handleClick = () => {
    backgroundRpc
      .getTelemetryExport()
      .then(data => navigator.clipboard.writeText(JSON.stringify(data, null, 2)))
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
      title={t('CopyLogs.tooltip')}
    >
      {getLabel()}
    </button>
  );
};
