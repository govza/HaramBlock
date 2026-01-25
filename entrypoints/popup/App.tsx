import { useCallback } from 'react';

import { Content } from '@/entrypoints/popup/components/Content';
import { FlipCard } from '@/entrypoints/popup/components/FlipCard';
import { Footer } from '@/entrypoints/popup/components/footer/Footer';
import { Header } from '@/entrypoints/popup/components/Header';
import { PerformancePanel } from '@/entrypoints/popup/components/PerformancePanel';
import { HostDataProvider, useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { PopupLayout } from '@/entrypoints/popup/layouts/PopupLayout';

const PopupContent = () => {
  const { isGlobalMode, switchToGlobal, switchToLocal } = useHostDataContext();

  const handleFlip = useCallback(() => {
    if (isGlobalMode) {
      switchToLocal();
    } else {
      switchToGlobal();
    }
  }, [isGlobalMode, switchToGlobal, switchToLocal]);

  return (
    <PopupLayout>
      <FlipCard isFlipped={isGlobalMode} onFlip={handleFlip}>
        <FlipCard.Front>
          <Header />
          <Content />
          <PerformancePanel />
          <Footer />
        </FlipCard.Front>
        <FlipCard.Back>
          <Header />
          <Content />
          <PerformancePanel />
          <Footer />
        </FlipCard.Back>
      </FlipCard>
    </PopupLayout>
  );
};

function App() {
  return (
    <HostDataProvider>
      <PopupContent />
    </HostDataProvider>
  );
}

export default App;
