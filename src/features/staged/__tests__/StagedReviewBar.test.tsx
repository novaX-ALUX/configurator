import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import type { DiffRowStatus } from '../../params/paramUtils'
import type { StagedChange } from '../stagedStore'
import { StagedReviewBar } from '../StagedReviewBar'

/** Renders the bar exactly as a non-Setup consumer would: plain Maps, no Setup store. */
function renderBar(opts?: {
  pending?: Map<string, StagedChange>
  writeStatus?: Map<string, DiffRowStatus>
  writing?: boolean
  onWrite?: () => void
  onRevert?: () => void
}) {
  render(
    <StagedReviewBar
      pending={opts?.pending ?? new Map([['ATC_RAT_RLL_P', { value: 0.15, label: 'Rate Roll P' }]])}
      writeStatus={opts?.writeStatus ?? new Map()}
      writing={opts?.writing ?? false}
      onWrite={opts?.onWrite ?? (() => {})}
      onRevert={opts?.onRevert ?? (() => {})}
    />,
  )
}

describe('StagedReviewBar', () => {
  it('shows the pending count badge and one chip per Staged Change', () => {
    renderBar({
      pending: new Map([
        ['ATC_RAT_RLL_P', { value: 0.15, label: 'Rate Roll P' }],
        ['ATC_RAT_PIT_P', { value: 0.135, label: 'Rate Pitch P' }],
      ]),
    })
    expect(screen.getByText('2 pending — nothing written yet')).toBeInTheDocument()
    expect(screen.getByText('ATC_RAT_RLL_P → 0.15')).toBeInTheDocument()
    expect(screen.getByText('ATC_RAT_PIT_P → 0.135')).toBeInTheDocument()
  })

  it('lists a failed write with its per-param failure message', () => {
    renderBar({
      writeStatus: new Map([['ATC_RAT_RLL_P', { kind: 'mismatch', requested: 0.15, actual: 0.12 }]]),
    })
    expect(screen.getByText(/Board reports 0.12 \(requested 0.15\)/)).toBeInTheDocument()
  })

  it('wires the Write and Revert buttons to the callbacks', () => {
    const onWrite = vi.fn()
    const onRevert = vi.fn()
    renderBar({ onWrite, onRevert })
    fireEvent.click(screen.getByRole('button', { name: 'Write to board' }))
    expect(onWrite).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    expect(onRevert).toHaveBeenCalledOnce()
  })

  it('disables both buttons while writing', () => {
    renderBar({ writing: true })
    expect(screen.getByRole('button', { name: 'Writing values to the board…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Revert' })).toBeDisabled()
  })
})
