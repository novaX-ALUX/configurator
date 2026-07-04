import type { FlashLogEntry } from './flashSession'

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Dark scrollable log console (design file's black `flashLog` box, lines
 * 879-885 of `docs/design/novaX-Configurator.dc.html`) for either flash
 * session's `log` entries. Renders nothing once there is nothing to show —
 * both `FirmwarePage` and `DfuRecovery` only mount this once a session has
 * started, so an empty array here only happens right at `idle`.
 */
export function FlashLog({ entries }: { entries: FlashLogEntry[] }) {
  if (entries.length === 0) return null
  return (
    <div className="max-h-[170px] overflow-auto rounded-[10px] bg-nvx-text px-3.5 py-3">
      {entries.map((entry, i) => (
        <div key={i} className="font-mono text-[11px] leading-[1.8] text-[#B9C2CE]">
          <span className="text-nvx-muted">{formatTime(entry.ts)}</span>
          <span className="ml-2">{entry.text}</span>
        </div>
      ))}
    </div>
  )
}
