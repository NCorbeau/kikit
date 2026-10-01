import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { registerOfflineShell } from './offline-shell';

// The document session owns external storage/socket lifetimes. Mount it once.
createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.DEV) void registerOfflineShell();
