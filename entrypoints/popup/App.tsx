import { useCallback, useState } from 'react';

import { Content } from '@/entrypoints/popup/components/Content';
import { FlipCard } from '@/entrypoints/popup/components/FlipCard';
import { Footer } from '@/entrypoints/popup/components/footer/Footer';
import { Header } from '@/entrypoints/popup/components/Header';
import { HelpPanel } from '@/entrypoints/popup/components/HelpPanel';
import { PerformancePanel } from '@/entrypoints/popup/components/PerformancePanel';
import { HostDataProvider, useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { PopupLayout } from '@/entrypoints/popup/layouts/PopupLayout';

const PopupContent = () => {
  const { isGlobalMode, switchToGlobal, switchToLocal } = useHostDataContext();
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  const handleFlip = useCallback(() => {
    if (isGlobalMode) {
      switchToLocal();
    } else {
      switchToGlobal();
    }
  }, [isGlobalMode, switchToGlobal, switchToLocal]);

  const handleHelpToggle = useCallback(() => {
    setIsHelpOpen(prev => !prev);
  }, []);

  return (
    <PopupLayout>
      <FlipCard isFlipped={isGlobalMode} onFlip={handleFlip}>
        <FlipCard.Front>
          <Header />
          <Content />
          <HelpPanel isOpen={isHelpOpen} />
          <PerformancePanel />
          <Footer isHelpOpen={isHelpOpen} onHelpToggle={handleHelpToggle} />
        </FlipCard.Front>
        <FlipCard.Back>
          <Header />
          <Content />
          <HelpPanel isOpen={isHelpOpen} />
          <PerformancePanel />
          <Footer isHelpOpen={isHelpOpen} onHelpToggle={handleHelpToggle} />
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
