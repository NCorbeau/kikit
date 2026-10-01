export function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 2.5v9m-3-3 3 3 3-3M4 12.5v3A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-3"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export function UndoIcon({ redo = false }: { redo?: boolean }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"
      style={redo ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path
        d="M6 4 2.5 7.5 6 11M3 7.5h9a4.5 4.5 0 0 1 0 9h-2"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M16.9 11.5A7 7 0 0 1 8.5 3.1a7 7 0 1 0 8.4 8.4Z"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="3.3" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6 16 16M4 16l1.4-1.4M14.6 5.4 16 4"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
      />
    </svg>
  );
}
