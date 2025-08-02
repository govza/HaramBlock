import React from 'react';
import { createRoot } from 'react-dom/client';

import App from '@/entrypoints/popup/App.tsx';
import '@/entrypoints/popup/style.css';

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
