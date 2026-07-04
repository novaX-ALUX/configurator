#!/usr/bin/env node
/**
 * WebSocket <-> TCP bridge for talking to a MAVLink endpoint (ArduPilot
 * SITL's TCP console, default localhost:5760) from a browser/Node
 * `WebSocket` client — i.e. `WebSocketTransport` (src/core/transport/websocket.ts).
 *
 * Every WS client connection opens its own TCP connection to the target;
 * bytes are relayed unmodified in both directions. Either side closing (or
 * erroring) closes the other. Connect/disconnect events and byte counts are
 * logged to stderr.
 *
 * Uses the `ws` package (devDependency only — see docs/notes/sitl.md) for
 * the WebSocket *server* side: Node's built-in global `WebSocket` (available
 * since Node 21/22, used directly by `WebSocketTransport` in the browser and
 * in Task 2.6's integration test) is a client implementation only and has no
 * server counterpart, and hand-rolling an RFC6455 server (masking,
 * continuation frames, close handshake) would just be reimplementing `ws`
 * for a dev-only tool. This script is never imported by the app — it is
 * only ever run standalone via `node tools/sitl-bridge.mjs`, so `ws` never
 * ships in the production bundle.
 *
 * Usage: node tools/sitl-bridge.mjs [wsPort] [tcpHost] [tcpPort]
 *   wsPort   WebSocket listen port (default 5761)
 *   tcpHost  SITL TCP host (default localhost)
 *   tcpPort  SITL TCP port (default 5760)
 */
import { WebSocketServer } from 'ws'
import net from 'node:net'

const wsPort = Number(process.argv[2] ?? 5761)
const tcpHost = process.argv[3] ?? 'localhost'
const tcpPort = Number(process.argv[4] ?? 5760)

const wss = new WebSocketServer({ port: wsPort })
let nextConnectionId = 1

function log(message) {
  process.stderr.write(`[sitl-bridge] ${message}\n`)
}

log(`listening ws://localhost:${wsPort} -> tcp://${tcpHost}:${tcpPort}`)

wss.on('connection', (ws) => {
  const id = nextConnectionId++
  let bytesWsToTcp = 0
  let bytesTcpToWs = 0
  let tcpOpen = true
  let wsOpen = true

  log(`[#${id}] client connected`)

  const socket = net.createConnection({ host: tcpHost, port: tcpPort })
  socket.setNoDelay(true)

  const closeBoth = () => {
    if (tcpOpen) {
      tcpOpen = false
      socket.destroy()
    }
    if (wsOpen) {
      wsOpen = false
      ws.close()
    }
  }

  socket.on('connect', () => {
    log(`[#${id}] tcp connected to ${tcpHost}:${tcpPort}`)
  })
  socket.on('data', (chunk) => {
    bytesTcpToWs += chunk.length
    if (ws.readyState === ws.OPEN) ws.send(chunk)
  })
  socket.on('error', (err) => {
    log(`[#${id}] tcp error: ${err.message}`)
    closeBoth()
  })
  socket.on('close', () => {
    log(`[#${id}] tcp closed (tcp->ws ${bytesTcpToWs}B, ws->tcp ${bytesWsToTcp}B)`)
    closeBoth()
  })

  ws.on('message', (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
    bytesWsToTcp += chunk.length
    if (tcpOpen) socket.write(chunk)
  })
  ws.on('error', (err) => {
    log(`[#${id}] ws error: ${err.message}`)
    closeBoth()
  })
  ws.on('close', () => {
    log(`[#${id}] ws closed (tcp->ws ${bytesTcpToWs}B, ws->tcp ${bytesWsToTcp}B)`)
    closeBoth()
  })
})

wss.on('error', (err) => {
  log(`server error: ${err.message}`)
  process.exit(1)
})

function shutdown() {
  log('SIGINT received, shutting down')
  for (const client of wss.clients) client.terminate()
  wss.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
