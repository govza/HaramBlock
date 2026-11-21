import React from 'react';
import { createRoot } from 'react-dom/client';

import '@/assets/page.css';
import { ConsentTab } from '@/entrypoints/consent/ConsentTab';
import { t } from '@/utils/i18n';
import { backgroundRpc } from '@/utils/messaging/popup';
import { initClientTelemetry } from '@/utils/telemetry/setup/client';

initClientTelemetry('consent', batch => backgroundRpc.pushTelemetry(batch));
document.title = t('CloudPredictions.name');

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <ConsentTab />
    </React.StrictMode>,
  );
}
