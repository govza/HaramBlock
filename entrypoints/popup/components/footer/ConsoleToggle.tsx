import { useEffect, useState } from 'react';

import { getLogSettings, setLogSettings, onLogSettingsChange } from '@/utils/logging';

export const ConsoleToggle = () => {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    getLogSettings()
      .then(s => setEnabled(s.consoleEnabled))
      .catch(() => {});
    return onLogSettingsChange(s => setEnabled(s.consoleEnabled));
  }, []);

  const handleClick = () => {
    void setLogSettings({ consoleEnabled: !enabled });
  };

  return (
    <button
      className='cursor-pointer p-1'
      onClick={handleClick}
      title={enabled ? 'Disable console logs' : 'Enable console logs'}
    >
      <svg
        xmlns='http://www.w3.org/2000/svg'
        fill='none'
        viewBox='0 0 24 24'
        strokeWidth={1.5}
        stroke={enabled ? '#22c55e' : 'currentColor'}
        className='size-6'
      >
        <path
          strokeLinecap='round'
          strokeLinejoin='round'
          d='M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z'
        />
      </svg>
    </button>
  );
};
