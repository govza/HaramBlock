import { useState } from 'react';

import { VerticalTabs } from '@/entrypoints/options/components/VerticalTabs';
import { About } from '@/entrypoints/options/features/About';
import { CustomSettings } from '@/entrypoints/options/features/CustomSettings';
import { HostList } from '@/entrypoints/options/features/HostList';
import { Overview } from '@/entrypoints/options/features/Overview';
import { HostDataProvider } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

const tabIds = ['overview', 'hostList', 'customSettings', 'about'] as const;
type TabId = (typeof tabIds)[number];

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  const tabItems = tabIds.map(id => ({
    id,
    label: t(`OptionsPage.Tabs.${id}`),
  }));

  return (
    <HostDataProvider>
      <div className='h-screen'>
        <VerticalTabs items={tabItems} activeTab={activeTab} onTabChange={id => setActiveTab(id as TabId)}>
          {{
            overview: <Overview />,
            hostList: <HostList />,
            customSettings: <CustomSettings />,
            about: <About />,
          }}
        </VerticalTabs>
      </div>
    </HostDataProvider>
  );
}

export default App;
