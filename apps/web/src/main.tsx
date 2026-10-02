import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { registerOfflineShell } from './offline-shell';
import { initializeTheme } from './theme';

initializeTheme();
// The document session owns external storage/socket lifetimes. Mount it once.
createRoot(document.getElementById('root')!).render(<App />);

void registerOfflineShell();
