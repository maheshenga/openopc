import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageStudioApp } from './app';

const root = document.getElementById('root');
if (!root) throw new Error('Image Studio root is missing.');

createRoot(root).render(
  <StrictMode>
    <ImageStudioApp />
  </StrictMode>,
);
