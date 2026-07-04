// Minimal ambient declarations for the Web Serial and WebUSB APIs.
//
// These are browser APIs not yet included in TypeScript's bundled lib.dom.d.ts.
// Only the subset this project is expected to use (src/core/transport and
// src/core/firmware, added in later tasks) is declared here. Hand-written
// rather than pulling in @types/w3c-web-serial / @types/w3c-web-usb to avoid
// adding dependencies beyond the project's approved list.
//
// No import/export statements below: this keeps the file in "global script"
// mode so the interfaces merge into the global scope, matching how the real
// DOM lib types are declared.

// --- Web Serial ---

interface SerialPortInfo {
  usbVendorId?: number
  usbProductId?: number
}

type SerialParity = 'none' | 'even' | 'odd'
type SerialFlowControl = 'none' | 'hardware'

interface SerialOptions {
  baudRate: number
  dataBits?: 7 | 8
  stopBits?: 1 | 2
  parity?: SerialParity
  bufferSize?: number
  flowControl?: SerialFlowControl
}

interface SerialPortFilter {
  usbVendorId?: number
  usbProductId?: number
}

interface SerialPortRequestOptions {
  filters?: SerialPortFilter[]
}

interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  open(options: SerialOptions): Promise<void>
  close(): Promise<void>
  forget(): Promise<void>
  getInfo(): SerialPortInfo
}

interface SerialEventMap {
  connect: Event
  disconnect: Event
}

interface Serial extends EventTarget {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>
  getPorts(): Promise<SerialPort[]>
  addEventListener<K extends keyof SerialEventMap>(
    type: K,
    listener: (this: Serial, ev: SerialEventMap[K]) => void,
  ): void
  removeEventListener<K extends keyof SerialEventMap>(
    type: K,
    listener: (this: Serial, ev: SerialEventMap[K]) => void,
  ): void
}

// --- WebUSB ---

interface USBDeviceFilter {
  vendorId?: number
  productId?: number
  classCode?: number
  subclassCode?: number
  protocolCode?: number
  serialNumber?: string
}

interface USBDeviceRequestOptions {
  filters: USBDeviceFilter[]
}

type USBRequestType = 'standard' | 'class' | 'vendor'
type USBRecipient = 'device' | 'interface' | 'endpoint' | 'other'
type USBTransferStatus = 'ok' | 'stall' | 'babble'

interface USBControlTransferParameters {
  requestType: USBRequestType
  recipient: USBRecipient
  request: number
  value: number
  index: number
}

interface USBInTransferResult {
  data?: DataView
  status: USBTransferStatus
}

interface USBOutTransferResult {
  bytesWritten: number
  status: USBTransferStatus
}

/** One alternate setting of a `USBInterface` (added for task 3.3's DFU engine — the DfuSe alt-0 "Internal Flash" interface's `interfaceName` carries the flash sector-layout string). */
interface USBAlternateInterface {
  readonly alternateSetting: number
  readonly interfaceClass: number
  readonly interfaceSubclass: number
  readonly interfaceProtocol: number
  readonly interfaceName: string
}

/** Added for task 3.3's DFU engine (`dfu.ts`), which finds the DFU interface (`interfaceClass === 0xfe`) and reads its alt-0 `interfaceName`. */
interface USBInterface {
  readonly interfaceNumber: number
  readonly alternates: USBAlternateInterface[]
}

interface USBConfiguration {
  configurationValue: number
  interfaces: USBInterface[]
}

interface USBDevice extends EventTarget {
  readonly vendorId: number
  readonly productId: number
  readonly productName?: string
  readonly serialNumber?: string
  readonly configuration: USBConfiguration | null
  readonly configurations: USBConfiguration[]
  readonly opened: boolean
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(configurationValue: number): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  releaseInterface(interfaceNumber: number): Promise<void>
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>
  controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult>
  controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult>
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>
  transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>
  reset(): Promise<void>
}

interface USBEventMap {
  connect: Event
  disconnect: Event
}

interface USB extends EventTarget {
  requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>
  getDevices(): Promise<USBDevice[]>
  addEventListener<K extends keyof USBEventMap>(
    type: K,
    listener: (this: USB, ev: USBEventMap[K]) => void,
  ): void
  removeEventListener<K extends keyof USBEventMap>(
    type: K,
    listener: (this: USB, ev: USBEventMap[K]) => void,
  ): void
}

// --- navigator augmentation ---

interface Navigator {
  readonly serial: Serial
  readonly usb: USB
}
