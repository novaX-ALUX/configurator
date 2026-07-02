import { describe, expect, it } from 'vitest'
import { defs } from '../defs'

describe('defs (mavlink-mappings adapter)', () => {
  it('resolves HEARTBEAT (msgid 0): CRC_EXTRA, offset-annotated fields, name, reverse lookup', () => {
    expect(defs.crcExtraForMsgId(0)).toBe(50)
    expect(defs.messageName(0)).toBe('HEARTBEAT')
    expect(defs.msgIdForName('HEARTBEAT')).toBe(0)

    const fields = defs.fieldsForMsgId(0)
    expect(fields).toBeDefined()
    expect(fields).toContainEqual(
      expect.objectContaining({ name: 'type', type: 'uint8_t', offset: 4, size: 1, length: 0, extension: false }),
    )
    expect(fields).toContainEqual(
      expect.objectContaining({ name: 'custom_mode', type: 'uint32_t', offset: 0, size: 4 }),
    )
  })

  it('exposes STATUSTEXT extension fields (id, chunk_seq) with extension: true', () => {
    const msgid = defs.msgIdForName('STATUSTEXT')
    expect(msgid).toBeDefined()
    const fields = defs.fieldsForMsgId(msgid!)
    const idField = fields?.find((f) => f.name === 'id')
    expect(idField).toEqual(expect.objectContaining({ extension: true, offset: 51, size: 2 }))
  })

  it('returns undefined for an unknown msgid (no CRC_EXTRA, no fields, no name)', () => {
    const unknown = 0xfffff // out of range for any real dialect message
    expect(defs.crcExtraForMsgId(unknown)).toBeUndefined()
    expect(defs.fieldsForMsgId(unknown)).toBeUndefined()
    expect(defs.messageName(unknown)).toBeUndefined()
  })

  it('returns undefined for an unknown message name', () => {
    expect(defs.msgIdForName('NOT_A_REAL_MESSAGE')).toBeUndefined()
  })
})
