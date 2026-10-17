import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Ensure window.fetch has a safe setter in case browser extensions attempt to wrap it
try {
  const desc =
    Object.getOwnPropertyDescriptor(window, 'fetch') ||
    Object.getOwnPropertyDescriptor(Window.prototype, 'fetch');
  if (desc && desc.configurable !== false && !desc.writable && !desc.set) {
    let activeFetch = window.fetch.bind(window);
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      enumerable: true,
      get() {
        return activeFetch;
      },
      set(fn) {
        if (typeof fn === 'function') {
          activeFetch = fn;
        }
      },
    });
  }
} catch {
  // Ignore if non-configurable
}

createRoot(document.getElementById('root')!).render(<App />);
