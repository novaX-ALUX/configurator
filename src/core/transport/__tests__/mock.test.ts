import { describe, expect, it } from 'vitest'
import { MockTransport } from '../mock'
import { describeTransportContract } from './contract'

describeTransportContract('MockTransport', () => {
  const transport = new MockTransport()
  return {
    transport,
    feed: (bytes) => transport.feed(bytes),
    getSent: () => transport.sent,
    simulateDisconnect: (reason) => transport.simulateDisconnect(reason),
  }
})

describe('MockTransport', () => {
  it('exposes writes on `sent` in call order, verbatim', async () => {
    const transport = new MockTransport()
    await transport.open()

    await transport.write(new Uint8Array([1, 2]))
    await transport.write(new Uint8Array([3]))

    expect(transport.sent).toEqual([new Uint8Array([1, 2]), new Uint8Array([3])])
  })

  it('feed() before open() throws instead of silently dropping bytes', () => {
    const transport = new MockTransport()
    expect(() => transport.feed(new Uint8Array([1]))).toThrow()
  })
})
