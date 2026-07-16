# uPlot renders the Telemetry Charts, isolated behind a single chart-host component

The Telemetry Charts feature (issue #1) draws rolling 60-second windows of live
Samples — up to ~43 Series at ≤10 Hz — and must keep scrolling smoothly while
the rest of the app (parameter table, motor test) stays responsive. This repo
deliberately runs on a minimal dependency set (6 runtime packages before this
decision), so adding a charting library is not a default move: hand-written
canvas was seriously considered, and the heavyweight React chart stacks were
not a fit at all.

**Decision:** add **uPlot** (~48 KB min, MIT, zero transitive dependencies) as
the 7th runtime dependency, and confine every reference to it — the import,
its CSS, and its types — to one chart-host component
(`src/features/charts/ChartHost.tsx`). An ESLint `no-restricted-imports` rule
enforces the boundary, mirroring the existing `mavlink-mappings` →
`defs.ts` confinement. Everything outside the chart host speaks plain data
(timestamps + per-Series value arrays), so swapping the renderer later touches
exactly one file.

## Considered Options

- **Hand-written canvas** — no new dependency, but a correct streaming chart
  needs axis tick generation, device-pixel-ratio handling, time-axis label
  formatting, and gap (null) rendering; that is real surface area to write,
  test, and maintain for zero product differentiation. Rejected as
  reinventing a solved problem.
- **Chart.js / Recharts / ECharts** — general-purpose chart stacks, 10–40×
  uPlot's size, DOM- or plugin-heavy, and their animation/update models fight
  a 10 Hz streaming append. Rejected as oversized for a canvas line chart.
- **fl_chart-style resampling on a fixed timer** (axPlanner's approach) — not
  a library choice but a rendering model: it fabricates points between real
  arrivals. Rejected; the domain rule is that Samples are never fabricated,
  and uPlot's aligned-array `setData` draws exactly the real Samples.
- **uPlot** — purpose-built for high-density time series on canvas, columnar
  `[xs, ys...]` data that maps 1:1 onto the History Buffer's per-Series
  sample arrays, `null` values render as gaps (matching the Recorder's
  gap semantics), and `setData` redraws in microseconds. Chosen.

## Consequences

- Runtime dependencies go from 6 to 7; uPlot has zero transitive deps, so the
  audit surface grows by exactly one package.
- Only `ChartHost.tsx` may import `uplot` (lint-enforced). Chart features
  (subplots per Unit Group, pause, legend — issues #4/#5) build on the chart
  host's plain-data props, not on uPlot APIs.
- jsdom has no canvas, so component tests stub the chart host; uPlot's actual
  rendering is verified manually in a browser (pre-release hardware
  checklist).
- uPlot's ESM build is imported; its stylesheet (`uPlot.min.css`) ships with
  the bundle via the chart host's own import.
