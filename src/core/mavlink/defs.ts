/**
 * Adapter isolating this project's single allowed import of
 * `mavlink-mappings` (docs/notes/decisions-m1.md decisions 1/2/8). Every
 * other file consumes only the `GeneratedDefs` interface exported here —
 * never `mavlink-mappings` directly, and never its types, so that the
 * package (and its LGPL license — decision 3) stays swappable behind this
 * one file. Enforced by the `no-restricted-imports` ESLint rule in
 * `eslint.config.js`.
 *
 * `mavlink-mappings` is metadata-only: no pack/unpack methods, just each
 * message class's static `MAGIC_NUMBER` (CRC_EXTRA) and `FIELDS`
 * (offset-annotated field table, base fields then extension fields, wire
 * order). The three dialect registries are merged manually because each
 * dialect's `REGISTRY` only contains messages defined in that XML file, not
 * its `<include>`s (docs/notes/mavgen-spike.md).
 *
 * Import rule (load-bearing, see the spike): always import a dialect
 * submodule directly (`mavlink-mappings/dist/lib/<dialect>`), never the
 * package root — the root barrel re-exports `mavlink-mappings-gen`
 * (`xml2js`/`sax`), which balloons the bundle by ~45kB gzip and drags in
 * Node builtins Vite has to externalize.
 */
import * as minimal from 'mavlink-mappings/dist/lib/minimal'
import * as common from 'mavlink-mappings/dist/lib/common'
import * as ardupilotmega from 'mavlink-mappings/dist/lib/ardupilotmega'

/**
 * Field descriptor, adapted from mavlink-mappings' `MavLinkPacketField`
 * into a shape owned by this project (so that type never has to leak past
 * this file).
 */
export interface MavFieldDef {
  /** Wire/XML field name, snake_case (e.g. 'param_id'). */
  name: string
  /** MAVLink C type, e.g. 'uint8_t', 'char[]', 'float[]'. */
  type: string
  /** Byte offset within the (zero-extended) payload. */
  offset: number
  /** Byte size of one element (of the array, if `length > 0`). */
  size: number
  /** Array length; 0 for scalar fields. */
  length: number
  /** True for MAVLink2 extension fields (appended after base fields, encode-truncatable). */
  extension: boolean
}

export interface GeneratedDefs {
  crcExtraForMsgId(msgid: number): number | undefined
  fieldsForMsgId(msgid: number): MavFieldDef[] | undefined
  messageName(msgid: number): string | undefined
  msgIdForName(name: string): number | undefined
}

const registry = {
  ...minimal.REGISTRY,
  ...common.REGISTRY,
  ...ardupilotmega.REGISTRY,
}

const nameToId = new Map<string, number>()
for (const [idStr, ctor] of Object.entries(registry)) {
  nameToId.set(ctor.MSG_NAME, Number(idStr))
}

/** Adapter singleton — the one `GeneratedDefs` instance the rest of the app consumes. */
export const defs: GeneratedDefs = {
  crcExtraForMsgId(msgid) {
    return registry[msgid]?.MAGIC_NUMBER
  },
  fieldsForMsgId(msgid) {
    const ctor = registry[msgid]
    if (!ctor) return undefined
    return ctor.FIELDS.map((f) => ({
      name: f.source,
      type: f.type,
      offset: f.offset,
      size: f.size,
      length: f.length,
      extension: f.extension,
    }))
  },
  messageName(msgid) {
    return registry[msgid]?.MSG_NAME
  },
  msgIdForName(name) {
    return nameToId.get(name)
  },
}
