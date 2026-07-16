import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

/**
 * The ONLY file allowed to import `uplot` (lint-enforced — see
 * docs/adr/0001-uplot-for-telemetry-charts.md). Everything outside speaks
 * plain data: Sample timestamps plus per-Series value arrays, so the renderer
 * stays swappable behind this one component.
 *
 * Renders one Unit Group subplot: every Series here shares a physical unit,
 * drawn on a single true-scale Y axis (uPlot's default auto-range over the
 * real values — no normalization). The X axis is a rolling window pinned to
 * the newest Sample, so the trace scrolls at the data's real arrival rate and
 * simply freezes wherever it was when Samples stop (disconnect).
 *
 * The uPlot instance is created on the first non-empty data and destroyed
 * when data returns to empty (history cleared by the next connect), so a
 * restarted session begins from a blank plot instead of a stale time axis.
 * Series definitions (labels/colors) are fixed for the life of the component;
 * only `values` may change between renders.
 */

export interface ChartHostSeries {
  label: string
  /** Stroke color (CSS). */
  color: string
  /** One value per timestamp, index-aligned; `null` renders as a gap, never interpolated. */
  values: (number | null)[]
}

export interface ChartHostProps {
  /** Shared Sample receive times, ms, ascending. */
  timestampsMs: number[]
  series: ChartHostSeries[]
  /** X-axis span in seconds; the window is [newest - windowSec, newest]. */
  windowSec: number
}

const CHART_HEIGHT = 320

export function ChartHost({ timestampsMs, series, windowSec }: ChartHostProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)

  // No dependency array on purpose: data arrays get a fresh identity every
  // render (they're derived from the History Buffer), and the page only
  // re-renders at the telemetry cadence (~10Hz), so diffing them would cost
  // more than the setData call it saves.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (timestampsMs.length === 0) {
      plotRef.current?.destroy()
      plotRef.current = null
      return
    }

    const data: uPlot.AlignedData = [
      timestampsMs.map((t) => t / 1000),
      ...series.map((s) => s.values),
    ]

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
            // Pin the window to the newest Sample so the trace scrolls; on
            // disconnect Samples stop arriving and the window stops moving.
            range: (_u, _min, max) => [max - windowSec, max],
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
