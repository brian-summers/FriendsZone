import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App.js';
import { applyTheme, loadTheme } from './lib/theme.js';

// Applied before first paint so a stored dark preference does not flash light.
applyTheme(loadTheme());

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
