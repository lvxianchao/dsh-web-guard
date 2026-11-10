/**
 * Unit checks for the forwarding helpers that do not need a harness.
 *
 *   node test/unit.mjs
 *
 * These run against the built `lib/proxy.js`, so they also catch a stale or
 * hand-edited build output. `test/e2e.mjs` covers the behaviour that needs a
 * running gate; this file covers the header set it forwards.
 */
import assert from 'node:assert/strict'

const { upstreamHeaders } = await import('../lib/proxy.js')

const target = new URL('http://127.0.0.1:3080')
let passed = 0

const test = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (err) {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${err.message}`)
    process.exitCode = 1
  }
}

test('rewrites Host and Origin to the upstream authority', () => {
  const h = upstreamHeaders(
    { host: 'dsh.example.com:4443', origin: 'https://dsh.example.com:4443' },
    target,
    'session=abc',
  )
  assert.equal(h.host, '127.0.0.1:3080')
  assert.equal(h.origin, 'http://127.0.0.1:3080')
  assert.equal(h.cookie, 'session=abc')
  assert.equal(h['x-forwarded-proto'], 'http')
})

test('drops Referer instead of forwarding the public authority', () => {
  // A same-origin GET fetch sends no Origin but does send Referer; plugins that
  // fall back to `Origin || Referer` for their own loopback check would 403.
  const h = upstreamHeaders(
    { host: 'dsh.example.com:4443', referer: 'https://dsh.example.com:4443/settings' },
    target,
    'session=abc',
  )
  assert.equal(h.referer, undefined)
  assert.equal(h.Referer, undefined)
  assert.equal(h.host, '127.0.0.1:3080')
})

test('does not invent an Origin when the browser sent none', () => {
  const h = upstreamHeaders({ host: 'dsh.example.com:4443' }, target, '')
  assert.equal(h.origin, undefined)
  assert.equal(h.cookie, undefined)
})

test('keeps end-to-end headers and strips hop-by-hop ones', () => {
  const h = upstreamHeaders(
    {
      host: 'dsh.example.com',
      accept: 'application/json',
      'accept-language': 'zh-CN',
      'sec-fetch-site': 'same-origin',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      'proxy-connection': 'keep-alive',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
    },
    target,
    '',
  )
  assert.equal(h.accept, 'application/json')
  assert.equal(h['accept-language'], 'zh-CN')
  assert.equal(h['sec-fetch-site'], 'same-origin')
  for (const gone of ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']) {
    assert.equal(h[gone], undefined, `${gone} should be stripped`)
  }
})

test('keeps the authenticated cookie even when the browser sent one', () => {
  const h = upstreamHeaders({ host: 'dsh.example.com', cookie: 'stale=1' }, target, 'session=fresh')
  assert.equal(h.cookie, 'session=fresh')
})

console.log(`\n${passed} unit check(s) passed${process.exitCode ? ', some failed' : ''}`)
