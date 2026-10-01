export function AppHeader() {
  return (
    <header className="app-header">
      <a className="brand" href="/" aria-label="Kikit home">
        <span className="brand-mark" aria-hidden="true">
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
            <path
              d="M6 4v16M18 4 8 12l10 8M12 9l6 3-6 3"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </span>
        kikit<span className="brand-dot">.</span>
      </a>
      <span className="header-divider" aria-hidden="true" />
      <span className="notebook-label">Development notebook</span>
      <span className="dev-badge">Local preview</span>
    </header>
  );
}
