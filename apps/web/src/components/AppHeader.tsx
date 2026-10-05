import type { ReactNode } from 'react';
import { ThemeToggle } from './ThemeToggle';
import { HeaderMenu } from './HeaderMenu';

export function AppHeader({ children, onHome, navigation, status, menuExtras, menuFooter, menuLabel = 'App menu' }: {
  children: ReactNode;
  onHome?(): void;
  navigation?: ReactNode;
  status?: ReactNode;
  menuExtras?: ReactNode;
  menuFooter?: ReactNode;
  menuLabel?: string;
}) {
  return (
    <header className="app-header">
      <a className="brand" href="/" aria-label="Kikit home" onClick={onHome ? event => { event.preventDefault(); onHome(); } : undefined}>
        Kikit
      </a>
      {navigation}
      {import.meta.env.DEV && <span className="dev-badge">Development</span>}
      <div className="document-actions">
        {status}
        <HeaderMenu label={menuLabel}>
          {children && <div className="menu-section">{children}</div>}
          <div className="menu-section">
            <p className="menu-label">Appearance</p>
            <ThemeToggle />
          </div>
          {menuExtras && <div className="menu-section">{menuExtras}</div>}
          {menuFooter && <div className="menu-section">{menuFooter}</div>}
        </HeaderMenu>
      </div>
    </header>
  );
}
