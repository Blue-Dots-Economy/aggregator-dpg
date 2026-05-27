import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  // `class` strategy — toggle the `dark` class on `<html>` (managed by
  // ThemeModeProvider) so we can flip between light/dark without
  // following the OS preference unless the user opts in.
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Brand-driven CSS variables (set by ThemeProvider from
        // `brand.json.typography`). Fall back to the original Plus
        // Jakarta + Inter pairing so renders look reasonable before
        // the network call resolves.
        display: ['var(--bd-font-heading)', '"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        sans: ['var(--bd-font-sans)', 'Inter', 'system-ui', 'sans-serif'],
        body: ['var(--bd-font-body)', 'var(--bd-font-sans)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        ink: {
          50: '#F4F6FB',
          100: '#E5E8F2',
          200: '#C5CADD',
          300: '#9098B5',
          400: '#6B7493',
          500: '#475069',
          600: '#2A3350',
          700: '#1E263F',
          800: '#141A2E',
          900: '#0B1020',
        },
      },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        pulseDot: {
          '0%,100%': { transform: 'scale(1)', opacity: '1' },
          '50%': { transform: 'scale(1.4)', opacity: '0.5' },
        },
      },
      animation: {
        'fade-up': 'fadeUp .35s ease-out both',
        'pulse-dot': 'pulseDot 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
