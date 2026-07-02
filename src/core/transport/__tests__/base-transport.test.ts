import { describe, expect, it } from 'vitest'
import { MockTransport } from '../mock'

// Regression test for a race found in architecture review: close() called
// while a doOpen() is still in flight must not be silently undone when
// that doOpen() later resolves. BaseTransport is exercised through
// MockTransport here since the race is in the shared state machine, not in
// any implementation-specific I/O.
describe('BaseTransport: close() racing a pending open()', () => {
  it('close() called before open() settles wins: the transport stays closed', async () => {
    const transport = new MockTransport()

    const openPromise = transport.open() // doOpen() is now in flight (unsettled)
    await transport.close() // races it — close() must win
    await openPromise // let the pending open() continuation run

    expect(() => transport.readable).toThrow()
    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow()
    // A fresh open() afterward must still work — no corrupted state left behind.
    await expect(transport.open()).resolves.toBeUndefined()
  })
})
