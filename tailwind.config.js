/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Every colour resolves through a CSS custom property so a generated
      // theme is a variable swap, never a class change. This is what makes
      // live re-theming possible without a reload.
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        // Status roles are tokens rather than palette literals so all five
        // widget tones follow a generated theme. Hardcoding emerald/amber here
        // is the defect this project exists to avoid repeating.
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        positive: {
          DEFAULT: 'hsl(var(--positive))',
          foreground: 'hsl(var(--positive-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        serif: ['var(--font-serif)'],
        mono: ['var(--font-mono)'],
        display: ['var(--font-display)'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      // Durations and easings are variables too, so `motion: 'playful'` in a
      // generated theme changes how the whole app moves.
      transitionDuration: {
        instant: 'var(--duration-instant)',
        quick: 'var(--duration-quick)',
        settle: 'var(--duration-settle)',
        reflow: 'var(--duration-reflow)',
      },
      transitionTimingFunction: {
        enter: 'var(--ease-enter)',
        exit: 'var(--ease-exit)',
        standard: 'var(--ease-standard)',
        emphasis: 'var(--ease-emphasis)',
      },
      keyframes: {
        // Opacity and transform only, so an animating list never triggers
        // layout.
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'grow-x': {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' },
        },
        // Two beats and done. A panel that pulses forever stops being a signal.
        'attention-pulse': {
          '0%, 100%': { transform: 'scale(1)', opacity: '1' },
          '35%': { transform: 'scale(1.03)', opacity: '0.92' },
        },
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
      },
      animation: {
        'rise-in': 'rise-in var(--duration-settle) var(--ease-enter) both',
        'fade-in': 'fade-in var(--duration-quick) var(--ease-standard) both',
        'scale-in': 'scale-in var(--duration-settle) var(--ease-enter) both',
        'slide-in-right': 'slide-in-right var(--duration-settle) var(--ease-enter) both',
        'grow-x': 'grow-x var(--duration-reflow) var(--ease-enter) both',
        'attention-pulse': 'attention-pulse 520ms var(--ease-emphasis) 2',
        shimmer: 'shimmer 2s linear infinite',
      },
    },
  },
  plugins: [],
};
