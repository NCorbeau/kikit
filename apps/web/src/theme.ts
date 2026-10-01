export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'kikit-theme';
const listeners = new Set<() => void>();
let theme: Theme = 'light';
let preference: Theme | null = null;
let systemTheme: MediaQueryList;
let initialized = false;

function readPreference(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(next: Theme) {
  theme = next;
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content', next === 'dark' ? '#191919' : '#ffffff',
  );
  listeners.forEach(listener => listener());
}

export function initializeTheme() {
  if (initialized) return;
  initialized = true;
  systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  preference = readPreference();
  applyTheme(preference ?? (systemTheme.matches ? 'dark' : 'light'));
  systemTheme.addEventListener('change', event => {
    if (preference === null) applyTheme(event.matches ? 'dark' : 'light');
  });
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    preference = readPreference();
    applyTheme(preference ?? (systemTheme.matches ? 'dark' : 'light'));
  });
}

export function setTheme(next: Theme) {
  preference = next;
  // A blocked preference store must not interrupt editing or change the theme
  // back during this visit. Persistence is independent from the note journal.
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Keep the selected theme in memory when browser storage is unavailable.
  }
  applyTheme(next);
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getTheme() {
  return theme;
}
