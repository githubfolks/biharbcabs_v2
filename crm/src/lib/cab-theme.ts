export interface CabCategoryTheme {
  card: string;
  badge: string;
  accentText: string;
  rowTint: string;
}

const THEMES: Record<string, CabCategoryTheme> = {
  BIKE: {
    card: 'border-teal-300 bg-teal-50/80 hover:border-teal-500',
    badge: 'bg-teal-600 text-white',
    accentText: 'text-teal-900',
    rowTint: 'bg-teal-50/40 border-l-4 border-l-teal-500',
  },
  MICRO: {
    card: 'border-sky-300 bg-sky-50/80 hover:border-sky-500',
    badge: 'bg-sky-600 text-white',
    accentText: 'text-sky-900',
    rowTint: 'bg-sky-50/40 border-l-4 border-l-sky-500',
  },
  MINI: {
    card: 'border-emerald-300 bg-emerald-50/80 hover:border-emerald-500',
    badge: 'bg-emerald-600 text-white',
    accentText: 'text-emerald-900',
    rowTint: 'bg-emerald-50/40 border-l-4 border-l-emerald-500',
  },
  SEDAN: {
    card: 'border-indigo-300 bg-indigo-50/80 hover:border-indigo-500',
    badge: 'bg-indigo-600 text-white',
    accentText: 'text-indigo-900',
    rowTint: 'bg-indigo-50/40 border-l-4 border-l-indigo-500',
  },
  PRIME_SEDAN: {
    card: 'border-violet-300 bg-violet-50/80 hover:border-violet-500',
    badge: 'bg-violet-600 text-white',
    accentText: 'text-violet-900',
    rowTint: 'bg-violet-50/40 border-l-4 border-l-violet-500',
  },
  SUV: {
    card: 'border-amber-300 bg-amber-50/80 hover:border-amber-500',
    badge: 'bg-amber-600 text-white',
    accentText: 'text-amber-900',
    rowTint: 'bg-amber-50/40 border-l-4 border-l-amber-500',
  },
  LUXURY: {
    card: 'border-rose-300 bg-rose-50/80 hover:border-rose-500',
    badge: 'bg-rose-600 text-white',
    accentText: 'text-rose-900',
    rowTint: 'bg-rose-50/40 border-l-4 border-l-rose-500',
  },
};

const DEFAULT_THEME: CabCategoryTheme = {
  card: 'border-slate-300 bg-slate-50 hover:border-slate-500',
  badge: 'bg-slate-700 text-white',
  accentText: 'text-slate-900',
  rowTint: 'bg-slate-50/50 border-l-4 border-l-slate-400',
};

export function getCabCategoryTheme(category?: string | null): CabCategoryTheme {
  const key = String(category || '').trim().toUpperCase();
  return THEMES[key] || DEFAULT_THEME;
}
