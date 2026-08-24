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
        'working-dot': {
          '0%, 70%, 100%': { opacity: '0.25' },
          '35%': { opacity: '1' },
        },
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
        // One character's hop. Transform-only, so a word of these animates on
        // the compositor; the wave across the word comes from per-character
        // `animation-delay` rather than from anything re-rendering.
        //
        // A ripple, not a bounce: the travel is small, and the character is at
        // rest for most of the cycle. That resting majority is also what makes
        // this safe to stop on hover-out — most of the time there is nothing
        // to settle from.
        'letter-jump': {
          '0%, 30%, 100%': { transform: 'translateY(0)' },
          '15%': { transform: 'translateY(-0.08em)' },
        },
        // The ambient half: colour only, so it composes with the hop instead
        // of competing for the same property.
        //
        // Two tokens, not a rainbow. `--foreground` is the mode's own ink —
        // black on light, white on dark, already flipped for us — and
        // `--primary` is whatever the theme's accent happens to be, so the
        // word breathes between "the same colour as the sentence" and "the
        // colour of the app" without inventing a third hue. Opens and closes
        // on the same token, so the loop has no seam.
        'hue-cycle': {
          '0%, 100%': { color: 'hsl(var(--foreground))' },
          '50%': { color: 'hsl(var(--primary))' },
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
        /*
          The dots beside a running tool call.

          Three elements sharing one keyframe, offset by their delay, so the
          wave costs no JavaScript and no re-render — see `WorkingDots`. Slow
          enough to read as breathing rather than as blinking, which is the
          difference between "working" and "something is wrong".
        */
        'working-dot': 'working-dot 1.35s var(--ease-standard) infinite',
        // Long enough that the wave crosses the word and then rests before it
        // starts again, which is what makes it read as a loop rather than as
        // continuous jitter.
        'letter-jump': 'letter-jump 1.9s var(--ease-emphasis) infinite',
        // Slower than the hop: this one is always running, and ambient colour
        // that changes quickly stops being ambient.
        'hue-cycle': 'hue-cycle 6s var(--ease-standard) infinite',
      },
    },
  },
  plugins: [],
};
