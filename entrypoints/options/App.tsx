import { useState } from 'react';

import { VerticalTabs, type TabItem } from '@/entrypoints/options/components/VerticalTabs';
import { About } from '@/entrypoints/options/features/About';
import { CustomSettings } from '@/entrypoints/options/features/CustomSettings';
import { HostList } from '@/entrypoints/options/features/HostList';
import { Overview } from '@/entrypoints/options/features/Overview';
import { HostDataProvider } from '@/entrypoints/popup/context/HostDataContext';

const tabItems: TabItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'hostList', label: 'List of hosts' },
  { id: 'customSettings', label: 'Custom settings' },
  { id: 'about', label: 'About' },
];

function App() {
  const [activeTab, setActiveTab] = useState<string>('overview');

  return (
    <HostDataProvider>
      <div className='h-screen'>
        <VerticalTabs items={tabItems} activeTab={activeTab} onTabChange={setActiveTab}>
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
