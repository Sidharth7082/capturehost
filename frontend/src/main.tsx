import '@fontsource-variable/inter';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// CSS order matters: tokens define the variables the rest consumes.
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
// Toolbar + name/meta cell furniture shared by every list page. Global on
// purpose: it used to hang off a page that is no longer imported, so pages
// rendered unstyled wherever they were loaded outside that graph.
import './styles/lists.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
