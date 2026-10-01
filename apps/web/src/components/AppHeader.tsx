import type { ReactNode } from 'react';
import { ThemeToggle } from './ThemeToggle';

export function AppHeader({ children }: { children: ReactNode }) {
  return (
    <header className="app-header">
      <a className="brand" href="/" aria-label="Kikit home">
        Kikit
      </a>
      <span className="dev-badge" title="Local development fixture. Accounts and private storage are not implemented.">Development</span>
      <div className="document-actions">
        {children}
        <ThemeToggle />
      </div>
    </header>
  );
}
