import type { ReactNode } from 'react';
import { ThemeToggle } from './ThemeToggle';

export function AppHeader({ children, onHome }: { children: ReactNode; onHome?(): void }) {
  return (
    <header className="app-header">
      <a className="brand" href="/" aria-label="Kikit home" onClick={onHome ? event => { event.preventDefault(); onHome(); } : undefined}>
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
