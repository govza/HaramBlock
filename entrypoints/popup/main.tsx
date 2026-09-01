import React from 'react';
import { createRoot } from 'react-dom/client';

import App from '@/entrypoints/popup/App.tsx';
import '@/entrypoints/popup/style.css';
import { t } from '@/utils/i18n';
import { backgroundRpc } from '@/utils/messaging/popup';
import { initClientTelemetry } from '@/utils/telemetry/setup/client';

initClientTelemetry('popup', batch => backgroundRpc.pushTelemetry(batch));
document.title = t('Extension.name');

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
