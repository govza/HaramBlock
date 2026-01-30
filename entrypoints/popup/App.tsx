import { useCallback, useEffect, useState } from 'react';

import { Content } from '@/entrypoints/popup/components/Content';
import { FlipCard } from '@/entrypoints/popup/components/FlipCard';
import { Footer } from '@/entrypoints/popup/components/footer/Footer';
import { Header } from '@/entrypoints/popup/components/Header';
import { HelpPanel } from '@/entrypoints/popup/components/HelpPanel';
import { HostDataProvider, useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { PopupLayout } from '@/entrypoints/popup/layouts/PopupLayout';
import { getLogSettings, onLogSettingsChange, setLogSettings } from '@/utils/logging';

const PopupContent = () => {
  const { isGlobalMode, switchToGlobal, switchToLocal } = useHostDataContext();
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  useEffect(() => {
    getLogSettings()
      .then(s => setIsHelpOpen(s.consoleEnabled))
      .catch(() => {});
    return onLogSettingsChange(s => setIsHelpOpen(s.consoleEnabled));
  }, []);

  const handleFlip = useCallback(() => {
    if (isGlobalMode) {
      switchToLocal();
    } else {
      switchToGlobal();
    }
  }, [isGlobalMode, switchToGlobal, switchToLocal]);

  const handleHelpToggle = useCallback(() => {
    setIsHelpOpen(prev => {
      void setLogSettings({ consoleEnabled: !prev });
      return !prev;
    });
  }, []);

  return (
    <PopupLayout>
      <FlipCard isFlipped={isGlobalMode} onFlip={handleFlip}>
        <FlipCard.Front>
          <Header />
          <Content />
          <HelpPanel isOpen={isHelpOpen} />
          <Footer isHelpOpen={isHelpOpen} onHelpToggle={handleHelpToggle} />
        </FlipCard.Front>
        <FlipCard.Back>
          <Header />
          <Content />
          <HelpPanel isOpen={isHelpOpen} />
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
