import { useSyncExternalStore } from 'react';
import { getTheme, setTheme, subscribeTheme } from '../theme';
import { MoonIcon, SunIcon } from './Icons';

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme);
  const next = theme === 'light' ? 'dark' : 'light';
  const label = `Switch to ${next} mode`;

  return (
    <button
      type="button" className="theme-button" aria-label={label}
      onClick={() => setTheme(next)}
    >
      {theme === 'light' ? <MoonIcon /> : <SunIcon />}
      <span>{label}</span>
    </button>
  );
}
