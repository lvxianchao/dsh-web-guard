/**
 * Admission-bridge checks: exercise both harness generations without needing
 * either one installed.
 *
 * DSH 0.2.3 replaced `connection.authenticatedUrl` with a credential-verifier
 * registry (`connection.authentication`). The guard must therefore work in two
 * shapes, and this file boots a mock host for each:
 *
 *  - `registry` shape (0.2.3+): exposes `connection.authentication` and
 *    `connection.createPeer`, no `authenticatedUrl`. The guard must register
 *    exactly one verifier, adopt a single owner Peer, accept its own session
 *    cookie on both carriers (`Headers` and a node header record), and refuse
 *    anonymous, foreign and revoked cookies.
 *  - `legacy` shape (0.2.2): the mirror image — no registry, `authenticatedUrl`
 *    present. The guard must register nothing and still exchange the token.
 *
 * Ports are overridable so two checkouts can run side by side:
 *   GUARD_ADMISSION_REGISTRY_PORT / GUARD_ADMISSION_LEGACY_PORT
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const PASSWORD = 'admission-probe-password'
const REGISTRY_PORT = Number(process.env.GUARD_ADMISSION_REGISTRY_PORT ?? 3107)
const LEGACY_PORT = Number(process.env.GUARD_ADMISSION_LEGACY_PORT ?? 3108)

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function untilReady(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__guard/health`)
      if (res.ok) return true
    } catch {}
    await sleep(100)
  }
  return false
}

/** Boot the guard against a mock host context of the requested shape. */
async function boot({ registry, port }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-guard-admission-'))
  const profileDir = join(root, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: en\n')

  const providers = []
  const calls = { authenticatedUrl: 0, createPeer: 0 }
  const registryService = {
    register(provider) {
      providers.push(provider)
      return async () => {}
    },
  }
  const ctx = {
    webServer: {
      getOrigin: () => 'http://127.0.0.1:3999',
      tapIndex: () => () => {},
      config: { host: '127.0.0.1' },
    },
    connection: {
      createPeer: (options) => {
        calls.createPeer += 1
        return { id: 'admission-probe-peer', principal: options.principal }
      },
      ...(registry
        ? {}
        : {
            authenticatedUrl: (url) => {
              calls.authenticatedUrl += 1
              return `${url}?token=probe`
            },
          }),
    },
    get: (name) => (name === 'connection.authentication' && registry ? registryService : undefined),
    profileContext: { patchPath: join(profileDir, 'cordis.patch.yml') },
    effect: (callback) => {
      const disposer = callback()
      return () => (typeof disposer === 'function' ? disposer() : undefined)
    },
  }

  const { apply } = await import(LIB)
  const handle = apply(ctx, {
    listenHost: '127.0.0.1',
    listenPort: port,
    password: PASSWORD,
    sessionDays: 7,
    title: 'admission probe',
  })
  const ready = await untilReady(port)
  return { handle, providers, calls, port, ready }
}

async function signIn(port) {
  const res = await fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(PASSWORD)}`,
    redirect: 'manual',
  })
  const cookie = (res.headers.getSetCookie() ?? [])
    .map((line) => line.split(';')[0])
    .filter(Boolean)
    .join('; ')
  return { status: res.status, cookie }
}

// ── 0.2.3 shape: the credential-verifier registry ────────────────────────────
console.log('admission — registry shape (0.2.3+)')
{
  const { handle, providers, calls, port, ready } = await boot({ registry: true, port: REGISTRY_PORT })
  check('listener answers its health endpoint', ready)
  check('exactly one verifier registered', providers.length === 1, `${providers.length}`)
  check('one owner Peer created', calls.createPeer === 1, `${calls.createPeer}`)

  const { status, cookie } = await signIn(port)
  check('sign-in succeeds', status === 302 && cookie.startsWith('dsh_guard='), `${status} ${cookie}`)

  const verifier = providers[0]
  if (verifier === undefined) {
    check('verifier is callable', false)
  } else {
    const admitted = verifier.authenticate({ headers: { cookie } })
    check('session cookie is admitted', Boolean(admitted), String(admitted))
    check('admitted Peer speaks as owner', admitted?.principal?.kind === 'owner', JSON.stringify(admitted?.principal))
    check('anonymous request is refused', verifier.authenticate({ headers: {} }) === undefined)
    check('foreign cookie is refused', verifier.authenticate({ headers: { cookie: 'dsh_guard=nexistepas' } }) === undefined)
    check('Fetch Headers carrier is accepted', Boolean(verifier.authenticate({ headers: new Headers({ cookie }) })))

    // Revocation has to reach the verifier: the session table is the only source.
    await fetch(`http://127.0.0.1:${port}/logout`, { headers: { cookie }, redirect: 'manual' })
    check('revoked session is refused immediately', verifier.authenticate({ headers: { cookie } }) === undefined)
  }
  handle.stop()
  await sleep(200)
}

// ── 0.2.2 shape: the launch-token exchange ───────────────────────────────────
console.log('admission — legacy shape (0.2.2)')
{
  const { handle, providers, calls, port, ready } = await boot({ registry: false, port: LEGACY_PORT })
  check('listener answers its health endpoint', ready)
  check('no verifier registered', providers.length === 0, `${providers.length}`)
  check('no Peer created', calls.createPeer === 0, `${calls.createPeer}`)

  const { status, cookie } = await signIn(port)
  check('sign-in succeeds', status === 302 && cookie.startsWith('dsh_guard='), `${status}`)
  // The upstream is a dead loopback port, so the proxy answers 502 — the point
  // is that the token exchange was attempted at all.
  await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie }, redirect: 'manual' }).catch(() => null)
  await sleep(300)
  check('launch token exchange attempted', calls.authenticatedUrl >= 1, `${calls.authenticatedUrl}`)
  handle.stop()
  await sleep(200)
}

console.log(failures === 0 ? '\nall admission check(s) passed' : `\n${failures} admission check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
