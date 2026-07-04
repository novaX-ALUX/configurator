/** Small presentation helpers shared by `FirmwarePage`/`DfuRecovery` — split out of either page component so both stay fast-refresh-friendly (a component file that also exports plain functions breaks React Fast Refresh). */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
