import { Content } from '@/entrypoints/popup/components/Content';
import { Header } from '@/entrypoints/popup/components/Header';
import { HostDataProvider } from '@/entrypoints/popup/context/HostDataContext';
import { PopupLayout } from '@/entrypoints/popup/layouts/PopupLayout';

function App() {
  return (
    <HostDataProvider>
      <PopupLayout>
        <Header />
        <Content />
      </PopupLayout>
    </HostDataProvider>
  );
}

export default App;
