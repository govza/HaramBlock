import React from 'react';
import { createRoot } from 'react-dom/client';

import App from '@/entrypoints/options/App.tsx';
import '@/entrypoints/options/style.css';

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
