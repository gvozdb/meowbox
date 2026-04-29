const STORAGE_KEY = 'meowbox-theme';

type Theme = 'dark' | 'light';

const currentTheme = ref<Theme>('dark');

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.classList.add('theme-transitioning');
  if (theme === 'light') {
    html.classList.add('theme-light');
  } else {
    html.classList.remove('theme-light');
  }
  setTimeout(() => html.classList.remove('theme-transitioning'), 350);
}

export function useTheme() {
  function init() {
    if (typeof localStorage === 'undefined') return;
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (saved === 'light' || saved === 'dark') {
      currentTheme.value = saved;
    }
    // Apply immediately without transition on init
    if (typeof document !== 'undefined') {
      if (currentTheme.value === 'light') {
        document.documentElement.classList.add('theme-light');
      } else {
        document.documentElement.classList.remove('theme-light');
      }
    }
  }

  function toggle() {
    const next: Theme = currentTheme.value === 'dark' ? 'light' : 'dark';
    currentTheme.value = next;
    applyTheme(next);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, next);
    }
  }

  const isDark = computed(() => currentTheme.value === 'dark');

  return { currentTheme, isDark, toggle, init };
}
