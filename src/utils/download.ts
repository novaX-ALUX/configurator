/**
 * Triggers a browser "Save As" for `content` as a same-origin, no-network
 * download — the standard Blob + object-URL + synthetic-anchor-click
 * pattern (no library: this is a few lines, not worth a dependency per
 * CLAUDE.md §8). `URL.revokeObjectURL` runs synchronously right after the
 * click dispatch; browsers keep the object URL alive long enough to service
 * the navigation it just triggered, so this doesn't race the download.
 * Shared by the `.param` export (paramFileUtils) and the Charts CSV export.
 */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
