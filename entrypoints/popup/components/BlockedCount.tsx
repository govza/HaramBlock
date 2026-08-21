import { useEffect, useState } from 'react';

import { t } from '@/utils/i18n';

export const BlockedCount = () => {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const fetchCount = async () => {
      const action = browser.action ?? browser.browserAction;
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) return;

      const text = await action.getBadgeText({ tabId });
      setCount(text ? parseInt(text, 10) || 0 : 0);
    };
    void fetchCount();
  }, []);

  if (!count) return null;

  return (
    <p className='mb-2 text-center text-xs text-muted'>
      {t('BlockedCount.label')} <span className='font-semibold text-white'>{count}</span>
    </p>
  );
};
