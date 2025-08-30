import { Content } from '@/entrypoints/popup/components/Content';
import { DeveloperPanel } from '@/entrypoints/popup/components/DeveloperPanel';
import { Footer } from '@/entrypoints/popup/components/footer/Footer';
import { Header } from '@/entrypoints/popup/components/Header';
import { HostDataProvider } from '@/entrypoints/popup/context/HostDataContext';
import { PopupLayout } from '@/entrypoints/popup/layouts/PopupLayout';

function App() {
  return (
    <HostDataProvider>
      <PopupLayout>
        <Header />
        <Content />
        <DeveloperPanel />
        <Footer />
      </PopupLayout>
    </HostDataProvider>
  );
}

export default App;
