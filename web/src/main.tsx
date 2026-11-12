import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/space-mono/latin-700.css';
import { App } from './App.tsx';
import './styles.css';
import './timeline/timeline.css';
import './sources/sources.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
