import { useEffect, useState } from 'react'

interface OfflineChipProps {
  /** Whether the offline state is current — the chip fades in when this goes true and fades out (rather than disappearing instantly) when it goes false, so the "Offline→online" direction the task brief names gets the same treatment as the reverse. */
  active: boolean
  label: string
  /** Layout hook for callers that need to place this chip in a shared flex slot (e.g. GpsCard's fix-badge column) — merged onto the chip's own root element instead of a wrapper, so an inactive/not-yet-fading chip (which renders nothing) never reserves space. */
  className?: string
}

/** Matches the `duration-200` Tailwind class below — the exit fade must finish before the chip actually unmounts. */
const EXIT_MS = 200

/**
 * Neutral "offline" state pill (UI G5, issue #10). Dashboard's per-Block
 * cards and the Charts page render this instead of a full-page placeholder
 * when disconnected, so live-value areas can honestly show em-dash/zeroed
 * data next to an explicit marker rather than pretending it's live.
 *
 * Task brief: "Offline→online transition: use a simple opacity/color
 * transition (~150-200ms, ease-out); no movement animations; respect
 * prefers-reduced-motion." Both directions fade rather than just the
 * entrance: going offline fades the chip in (via `@starting-style` — safe to
 * rely on since Web Serial is Chromium-only, and every Chromium release this
 * app can run on has shipped it since 2023); reconnecting fades it back out
 * instead of vanishing mid-render, so the chip stays mounted for `EXIT_MS`
 * after `active` goes false to let the opacity transition finish.
 * `motion-reduce:transition-none` drops the animation for
 * `prefers-reduced-motion` users — the chip still appears/disappears at the
 * same points, just without the transition.
 */
export function OfflineChip({ active, label, className = '' }: OfflineChipProps) {
  const [mounted, setMounted] = useState(active)

  // "Adjusting state when a prop changes" (same pattern as
  // dashboard/useTelemetry.ts and ChartsPage's own pause-reset): going active
  // remounts synchronously, in the render phase, rather than via an effect —
  // an effect exists below only for the genuinely async half (the exit
  // timer), not to mirror a prop into state.
  const [prevActive, setPrevActive] = useState(active)
  if (active !== prevActive) {
    setPrevActive(active)
    if (active) setMounted(true)
  }

  useEffect(() => {
    if (active) return
    const timer = setTimeout(() => setMounted(false), EXIT_MS)
    return () => clearTimeout(timer)
  }, [active])

  if (!mounted) return null

  return (
    <span
      // Hidden from assistive tech the instant it's no longer accurate,
      // even while it's still visually fading out for sighted users.
      aria-hidden={active ? undefined : true}
      className={`inline-flex items-center rounded-full bg-nvx-field px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide text-nvx-faint transition-opacity duration-200 ease-out motion-reduce:transition-none [@starting-style]:opacity-0 ${active ? 'opacity-100' : 'opacity-0'} ${className}`}
    >
      {label}
    </span>
  )
}
