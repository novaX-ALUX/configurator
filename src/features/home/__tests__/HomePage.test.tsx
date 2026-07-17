import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { HomePage } from '../HomePage'
import { useConnectionStore } from '../../../store/connection'
import { useNavigationStore } from '../../../store/navigation'
import { useSetupStore } from '../../setup/setupStore'
import { useCalibrationProgress } from '../../calibration/calibrationProgress'
import { useMotorTestStore } from '../../motors/motorTestStore'
import { useTuningStore } from '../../tuning/tuningStore'

const initialConnection = useConnectionStore.getState()
const initialNav = useNavigationStore.getState()
const initialSetup = useSetupStore.getState()
const initialCalProgress = useCalibrationProgress.getState()
const initialMotorTest = useMotorTestStore.getState()
const initialTuning = useTuningStore.getState()

afterEach(() => {
  useConnectionStore.setState(initialConnection, true)
  useNavigationStore.setState(initialNav, true)
  useSetupStore.setState(initialSetup, true)
  useCalibrationProgress.setState(initialCalProgress, true)
  useMotorTestStore.setState(initialMotorTest, true)
  useTuningStore.setState(initialTuning, true)
  vi.restoreAllMocks()
})

describe('HomePage: guide steps first-class (same derivation as the drawer)', () => {
  it('shows all 6 steps as "To do" and 0 / 6 on a fresh session', () => {
    render(<HomePage />)
    expect(screen.getByText('0 / 6')).toBeInTheDocument()
    expect(screen.getAllByText('To do')).toHaveLength(6)
    expect(screen.queryByText('Done')).not.toBeInTheDocument()
  })

  it('reflects the exact same store flags the drawer derives from', () => {
    useConnectionStore.setState({ phase: 'connected' })
    useSetupStore.setState({ frameEscTouched: true, fsTouched: false })
    useCalibrationProgress.setState({ accelDone: true, compassApplied: true, rcCalApplied: true })
    useMotorTestStore.setState({ motorsTested: false })

    render(<HomePage />)

    // connect + frameEsc + calibrate done; motorTest + failsafes + initialTune still to do
    expect(screen.getByText('3 / 6')).toBeInTheDocument()
    expect(screen.getAllByText('Done')).toHaveLength(3)
    expect(screen.getAllByText('To do')).toHaveLength(3)
  })

  it('"Open page" on a step switches the active page to that step\'s target', () => {
    render(<HomePage />)
    const openPageButtons = screen.getAllByRole('button', { name: 'Open page' })
    fireEvent.click(openPageButtons[3]) // step 4: motor test
    expect(useNavigationStore.getState().activePage).toBe('motors')
  })
})

describe('HomePage: Connect CTA', () => {
  it('triggers the same connection-store connect action as the top bar, with the shared baud', () => {
    const calls: unknown[][] = []
    useConnectionStore.setState({
      baud: 921600,
      connect: async (...args: unknown[]) => {
        calls.push(args)
      },
    })
    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(921600)
  })

  it('replaces the CTA with a connected note once a board is connected', () => {
    useConnectionStore.setState({ phase: 'connected' })
    render(<HomePage />)
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
    expect(screen.getByText('Board connected.')).toBeInTheDocument()
  })
})

describe('HomePage: rescue bypass', () => {
  it('lands on the Firmware page', () => {
    render(<HomePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Firmware' }))
    expect(useNavigationStore.getState().activePage).toBe('firmware')
  })
})

describe('HomePage: bench-side read-only guarantee', () => {
  it('never touches setupStore/motorTestStore/calibrationProgress/tuningStore state — only reads them', () => {
    const stageSpy = vi.spyOn(useSetupStore.getState(), 'stage')
    const setPercentSpy = vi.spyOn(useMotorTestStore.getState(), 'setMotorPercent')
    const markAccelSpy = vi.spyOn(useCalibrationProgress.getState(), 'markAccelDone')
    const stageManySpy = vi.spyOn(useTuningStore.getState(), 'stageMany')

    render(<HomePage />)
    for (const btn of screen.getAllByRole('button')) {
      fireEvent.click(btn)
    }

    expect(stageSpy).not.toHaveBeenCalled()
    expect(setPercentSpy).not.toHaveBeenCalled()
    expect(markAccelSpy).not.toHaveBeenCalled()
    expect(stageManySpy).not.toHaveBeenCalled()
  })
})
