import type { ReactNode } from 'react';
import { ThemeToggle } from './ThemeToggle';

export function AppHeader({ children }: { children: ReactNode }) {
  return (
    <header className="app-header">
      <a className="brand" href="/" aria-label="Kikit home">
        Kikit
      </a>
      {import.meta.env.DEV && <span className="dev-badge">Development</span>}
      <div className="document-actions">
        {children}
        <ThemeToggle />
      </div>
    </header>
  );
}
