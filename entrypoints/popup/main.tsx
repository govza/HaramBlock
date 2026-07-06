import React from 'react';
import { createRoot } from 'react-dom/client';

import App from '@/entrypoints/popup/App.tsx';
import '@/entrypoints/popup/style.css';
import { t } from '@/utils/i18n';
import { installDevDumpHook } from '@/utils/logging/devDump';

document.title = t('Extension.name');
installDevDumpHook();

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
