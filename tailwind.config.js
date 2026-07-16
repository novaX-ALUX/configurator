/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Design tokens lifted from docs/design/novaX-Configurator.dc.html (single visual
      // source of truth). Keep this list scoped to what the shell + page skeletons
      // actually use; feature pages extend it as they land against the same design file.
      //
      // Values are CSS custom properties (issue #11, UI G4 rider), defined once in
      // index.css's `:root` — this file just maps each nvx-* utility class to its
      // variable so every existing call site (`bg-nvx-primary`, `text-nvx-text`, ...)
      // keeps working unchanged. Tokens only: no dark-theme override ships here.
      colors: {
        nvx: {
          bg: 'var(--nvx-bg)',
          surface: 'var(--nvx-surface)',
          field: 'var(--nvx-field)',
          text: 'var(--nvx-text)',
          muted: 'var(--nvx-muted)',
          subtle: 'var(--nvx-subtle)',
          faint: 'var(--nvx-faint)',
          disabled: 'var(--nvx-disabled)',
          border: 'var(--nvx-border)',
          borderStrong: 'var(--nvx-border-strong)',
          primary: 'var(--nvx-primary)',
          primaryHover: 'var(--nvx-primary-hover)',
          primarySoft: 'var(--nvx-primary-soft)',
          primarySoftText: 'var(--nvx-primary-soft-text)',
          infoBorder: 'var(--nvx-info-border)',
          success: 'var(--nvx-success)',
          successText: 'var(--nvx-success-text)',
          successMuted: 'var(--nvx-success-muted)',
          successSoft: 'var(--nvx-success-soft)',
          warning: 'var(--nvx-warning)',
          warningText: 'var(--nvx-warning-text)',
          warningSoft: 'var(--nvx-warning-soft)',
          warningBorder: 'var(--nvx-warning-border)',
          danger: 'var(--nvx-danger)',
          dangerHover: 'var(--nvx-danger-hover)',
          // Not lifted verbatim from the design file (unlike the tokens above) — the
          // design only ever uses #DC2626/#B91C1C as solid banner/button backgrounds,
          // never as a soft row tint. Task 3.1 needs a light "error" row background for
          // STATUSTEXT severity coloring (design only demonstrates warning/default
          // tiers), so this is a same-lightness-relationship interpolation from
          // warningSoft/warningBorder onto the danger hue. Documented in task-3.1-report.md.
          dangerSoft: 'var(--nvx-danger-soft)',
          dangerBorder: 'var(--nvx-danger-border)',
          scrollThumb: 'var(--nvx-scroll-thumb)',
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
