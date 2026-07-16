import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

/**
 * The ONLY file allowed to import `uplot` (lint-enforced — see
 * docs/adr/0001-uplot-for-telemetry-charts.md). Everything outside speaks
 * plain data: per-Series Sample timestamps and values, so the renderer
 * stays swappable behind this one component.
 *
 * Renders one Unit Group subplot: every Series here shares a physical unit,
 * drawn on a single true-scale Y axis (uPlot's default auto-range over the
 * real values — no normalization). A Unit Group may span Blocks (e.g. RC and
 * servo both land on the µs subplot), and Blocks tick at different receive
 * times, so each Series brings its own timestamps and `uPlot.join` aligns
 * them onto one x array. The join's default null mode is exactly the gap
 * semantics the Recorder needs: a recorded `null` (field absent on the
 * vehicle) stays `null` and renders as a gap, while alignment holes (another
 * Block's timestamps) become `undefined`, which uPlot's path builder draws
 * straight through — never a fabricated gap.
 *
 * The X axis is a rolling window pinned to `windowEndMs` — the newest Sample
 * across the *whole page*, not this subplot, so stacked subplots share one
 * time axis. Samples stop arriving on disconnect and the window simply
 * freezes wherever it was.
 *
 * The uPlot instance is created on the first non-empty data and destroyed
 * when data returns to empty (history cleared by the next connect), so a
 * restarted session begins from a blank plot instead of a stale time axis.
 * Series definitions (labels/colors, even the series count) are fixed for
 * the life of the component — the Charts page remounts this component (React
 * key) when the Unit Group's selection changes; only `timestampsMs`/`values`
 * and `windowEndMs` may change between renders.
 */

export interface ChartHostSeries {
  label: string
  /** Stroke color (CSS). */
  color: string
  /** This Series' own Sample receive times, ms, ascending. */
  timestampsMs: number[]
  /** One value per timestamp; `null` renders as a gap, never interpolated. */
  values: (number | null)[]
}

export interface ChartHostProps {
  series: ChartHostSeries[]
  /** Newest Sample time (ms) across all subplots — the shared window's trailing edge. */
  windowEndMs: number
  /** X-axis span in seconds; the window is [windowEndMs - windowSec, windowEndMs]. */
  windowSec: number
}

const CHART_HEIGHT = 320

export function ChartHost({ series, windowEndMs, windowSec }: ChartHostProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  // The x-scale range closure below is created once (with the plot) but must
  // track the page-wide window end. Updated in the data effect below, before
  // the setData/create that triggers the redraw consulting it.
  const windowEndRef = useRef(windowEndMs)

  // No dependency array on purpose: data arrays get a fresh identity every
  // render (they're derived from the History Buffer), and the page only
  // re-renders at the telemetry cadence (~10Hz), so diffing them would cost
  // more than the setData call it saves.
  useEffect(() => {
    windowEndRef.current = windowEndMs
    const container = containerRef.current
    if (!container) return

    if (series.every((s) => s.timestampsMs.length === 0)) {
      plotRef.current?.destroy()
      plotRef.current = null
      return
    }

    const data = uPlot.join(
      series.map((s) => [s.timestampsMs.map((t) => t / 1000), s.values] as uPlot.AlignedData),
    )

    if (plotRef.current) {
      plotRef.current.setData(data)
      return
    }

    plotRef.current = new uPlot(
      {
        width: container.clientWidth,
        height: CHART_HEIGHT,
        legend: { show: false },
        cursor: { show: false },
        scales: {
          x: {
            // Pin the window to the page-wide newest Sample so all subplots
            // scroll in lockstep; on disconnect Samples stop arriving and the
            // window stops moving.
            range: () => [windowEndRef.current / 1000 - windowSec, windowEndRef.current / 1000],
          },
        },
        series: [
          {},
          ...series.map((s) => ({
            label: s.label,
            stroke: s.color,
            width: 1.5,
            spanGaps: false,
          })),
        ],
      },
      data,
      container,
    )
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => {
      plotRef.current?.setSize({ width: container.clientWidth, height: CHART_HEIGHT })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(
    () => () => {
      plotRef.current?.destroy()
      plotRef.current = null
    },
    [],
  )

  return <div ref={containerRef} />
}
