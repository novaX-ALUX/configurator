/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Design tokens lifted from docs/design/novaX-Configurator.dc.html (single visual
      // source of truth). Keep this list scoped to what the shell + page skeletons
      // actually use; feature pages extend it as they land against the same design file.
      colors: {
        nvx: {
          bg: '#F5F7FA',
          surface: '#FFFFFF',
          field: '#EFF2F6',
          text: '#171A20',
          muted: '#5C6470',
          subtle: '#7A828E',
          faint: '#98A1AE',
          disabled: '#B6BEC9',
          border: '#E3E8EF',
          borderStrong: '#D8DEE6',
          primary: '#2B5CE6',
          primaryHover: '#2450C7',
          primarySoft: '#E7EDFC',
          primarySoftText: '#23479F',
          infoBorder: '#B9C9F5',
          success: '#1E9E6A',
          successText: '#14603F',
          successMuted: '#3F8A65',
          successSoft: '#E4F5EC',
          warning: '#D97706',
          warningText: '#8A5A0B',
          warningSoft: '#FDF6E9',
          warningBorder: '#F0C98A',
          danger: '#DC2626',
          dangerHover: '#B91C1C',
          // Not lifted verbatim from the design file (unlike the tokens above) — the
          // design only ever uses #DC2626/#B91C1C as solid banner/button backgrounds,
          // never as a soft row tint. Task 3.1 needs a light "error" row background for
          // STATUSTEXT severity coloring (design only demonstrates warning/default
          // tiers), so this is a same-lightness-relationship interpolation from
          // warningSoft/warningBorder onto the danger hue. Documented in task-3.1-report.md.
          dangerSoft: '#FBEAEA',
          dangerBorder: '#F3B9B9',
          scrollThumb: '#D3DAE3',
        },
      },
      fontFamily: {
        sans: ['Manrope', 'system-ui', 'sans-serif'],
        heading: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(23,26,32,.04)',
        popover: '0 12px 32px rgba(23,26,32,.14)',
      },
      keyframes: {
        nvxPulse: { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
        nvxSpin: { to: { transform: 'rotate(360deg)' } },
        nvxToast: {
          from: { transform: 'translateY(10px)', opacity: 0 },
          to: { transform: 'translateY(0)', opacity: 1 },
        },
        nvxBar: { '0%': { backgroundPosition: '0 0' }, '100%': { backgroundPosition: '28px 0' } },
      },
      animation: {
        nvxPulse: 'nvxPulse 2.4s ease infinite',
        nvxSpin: 'nvxSpin .8s linear infinite',
        nvxToast: 'nvxToast .2s ease',
        nvxBar: 'nvxBar .6s linear infinite',
      },
    },
  },
  plugins: [],
}
