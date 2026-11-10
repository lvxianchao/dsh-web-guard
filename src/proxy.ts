/**
 * Transport layer for dsh-web-guard: an HTTP(S) server plus forwarding helpers.
 *
 * This module owns no authentication policy — the caller decides what to
 * forward. Its one job is to make an upstream DeepSeek Harness listener see a
 * loopback request: Host and Origin are rewritten to the upstream authority,
 * and Referer is dropped, since all three would otherwise carry the public
 * authority the browser used to reach the gate.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, RequestOptions, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { URL } from 'node:url'

/**
 * Headers never forwarded verbatim to the upstream.
 *
 * `referer` belongs here with `host`/`origin`: all three carry the public
 * authority the browser used, while the rest are hop-by-hop headers the proxy
 * owns. A plugin that re-checks "is this request same-origin from loopback"
 * reads `Origin || Referer`; a same-origin GET fetch sends no Origin but does
 * send Referer, so a verbatim public Referer makes an otherwise valid loopback
 * request look cross-origin and 403. Dropping it is also the honest choice —
 * the gate has already authenticated the request, and inventing a loopback
 * Referer would silently make a foreign document look same-origin.
 */
const DROP = new Set(['host', 'origin', 'referer', 'proxy-connection', 'connection', 'keep-alive', 'upgrade', 'transfer-encoding'])

/** Build the upstream header set with loopback authority substitution. */
export function upstreamHeaders(headers: IncomingHttpHeaders, target: URL, cookie: string): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    if (DROP.has(key.toLowerCase())) continue
    out[key] = value
  }
  out.host = target.host
  // Only restate Origin when the browser sent one: dsh accepts a request
  // without Origin, and a fabricated one would have to stay consistent.
  if (headers.origin !== undefined) out.origin = target.origin
  if (cookie) out.cookie = cookie
  out['x-forwarded-proto'] = target.protocol.replace(':', '')
  return out
}

export interface ListenerOptions {
  host: string
  port: number
  /** PEM chain path; with `tlsKey` enables HTTPS. */
  tlsCert: string | null
  tlsKey: string | null
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  log: (line: string) => void
}

export interface GuardListener {
  server: http.Server | https.Server
  listen(): Promise<void>
  close(): void
}

/** Create the public-facing listener. */
export function createListener(options: ListenerOptions): GuardListener {
  const { host, port, tlsCert, tlsKey, handler, onUpgrade, log } = options
  const wrapped = wrap(handler, log)
  let server: http.Server | https.Server
  if (tlsCert && tlsKey) {
    const secure = https.createServer(
      { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) },
      wrapped,
    )
    secure.on('tlsClientError', (err) => log(`tls error: ${err.message}`))
    server = secure
  } else {
    server = http.createServer(wrapped)
  }
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    try {
      onUpgrade(req, socket, head)
    } catch (err) {
      log(`upgrade error: ${errorMessage(err)}`)
      socket.destroy()
    }
  })
  server.on('clientError', (err: Error, socket: Duplex) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    log(`client error: ${err.message}`)
  })
  server.on('error', (err: Error) => log(`listener error: ${err.message}`))
  return {
    server,
    listen: () => new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      server.once('error', onError)
      server.listen(port, host, () => {
        server.removeListener('error', onError)
        resolve()
      })
    }),
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

function wrap(handler: ListenerOptions['handler'], log: (line: string) => void): http.RequestListener {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err: unknown) => {
      log(`handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh-web-guard: internal error\n')
      } else {
        res.destroy()
      }
    })
  }
}

export interface ForwardOptions {
  targetOrigin: string
  cookie: string
  agent: http.Agent
  log: (line: string) => void
}

/** Forward one HTTP request to the upstream listener. */
export function forward(req: IncomingMessage, res: ServerResponse, options: ForwardOptions): void {
  const { targetOrigin, cookie, agent, log } = options
  const target = new URL(targetOrigin)
  const secure = target.protocol === 'https:'
  const started = Date.now()
  const requestOptions: RequestOptions & { rejectUnauthorized: boolean } = {
    agent: secure ? undefined : agent,
    host: target.hostname,
    port: target.port || (secure ? 443 : 80),
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req.headers, target, cookie),
    rejectUnauthorized: false,
  }
  const proxyReq = secure
    ? https.request(requestOptions, (proxyRes) => forwardResponse(proxyRes, res, req, started, log))
    : http.request(requestOptions, (proxyRes) => forwardResponse(proxyRes, res, req, started, log))
  // A browser can walk away mid-response (tab closed, reload, flaky link).
  // Without this the upstream request survives the client, and a response that
  // never ends — an SSE stream, a long poll — keeps its socket allocated in the
  // shared keep-alive agent forever. Once `maxSockets` of those pile up every
  // later request queues until the proxy in front gives up (504).
  res.on('close', () => {
    if (!res.writableEnded) proxyReq.destroy()
  })
  proxyReq.on('error', (err: Error) => {
    // Destroying the upstream is the expected outcome of a client hangup.
    if (res.destroyed || res.writableEnded) return
    log(`upstream error ${req.method} ${req.url}: ${err.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-web-guard: upstream unreachable\n')
    } else {
      res.destroy()
    }
  })
  req.pipe(proxyReq)
}

function forwardResponse(proxyRes: IncomingMessage, res: ServerResponse, req: IncomingMessage, started: number, log: (line: string) => void): void {
  if (res.destroyed) {
    proxyRes.destroy()
    return
  }
  const headers: OutgoingHttpHeaders = { ...proxyRes.headers }
  // Never leak the harness cookie to the browser: the guard owns it.
  delete headers['set-cookie']
  res.writeHead(proxyRes.statusCode ?? 502, headers)
  proxyRes.on('error', () => res.destroy())
  proxyRes.pipe(res)
  // Quiet by default: the Web UI polls constantly. Log failures and slow
  // requests only, so the journal does not fill with 200s.
  proxyRes.on('end', () => {
    const code = proxyRes.statusCode ?? 0
    const ms = Date.now() - started
    if (code >= 400 || ms > 1000) log(`${req.method} ${req.url} ${code} ${ms}ms`)
  })
}

export interface UpgradeOptions {
  targetOrigin: string
  cookie: string
  log: (line: string) => void
}

/** Forward a WebSocket (or any HTTP upgrade) with the same header rewrite. */
export function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, options: UpgradeOptions): void {
  const { targetOrigin, cookie, log } = options
  const target = new URL(targetOrigin)
  const secure = target.protocol === 'https:'
  const port = Number(target.port || (secure ? 443 : 80))
  const lines: string[] = [`${req.method} ${req.url} HTTP/1.1`]
  const raw = req.rawHeaders ?? []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const lower = raw[i].toLowerCase()
    if (lower === 'host' || lower === 'origin' || lower === 'proxy-connection') continue
    lines.push(`${raw[i]}: ${raw[i + 1]}`)
  }
  lines.push(`Host: ${target.host}`)
  if (req.headers.origin !== undefined) lines.push(`Origin: ${target.origin}`)
  if (cookie) lines.push(`Cookie: ${cookie}`)
  lines.push('', '')

  const backend: net.Socket = secure
    ? tls.connect({ host: target.hostname, port, servername: target.hostname, rejectUnauthorized: false })
    : net.connect(port, target.hostname)
  const teardown = (err?: Error): void => {
    if (err) log(`ws error ${req.url}: ${err.message}`)
    socket.destroy()
    backend.destroy()
  }
  socket.on('error', (err: Error) => teardown(err))
  backend.on('error', (err: Error) => teardown(err))
  socket.on('close', () => backend.destroy())
  backend.on('close', () => socket.destroy())
  backend.on('connect', () => {
    log(`ws ${req.url}`)
    backend.write(lines.join('\r\n'))
    if (head?.length) backend.write(head)
    backend.pipe(socket)
    socket.pipe(backend)
  })
}

/** Shared keep-alive agent for upstream requests. */
export const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 128 })

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
