/** `HH:MM:SS` from a local clock timestamp — shared by `ConsolePage` (Messages/STATUSTEXT rows) and `FlashLog` (flash session log lines). */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
