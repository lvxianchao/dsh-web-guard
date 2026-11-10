# AGENTS.md — dsh-web-guard

A password gate for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web UI. One plugin that also removes the four things that break when a DSH Web UI leaves loopback: the `/api` 403 every reverse proxy causes, the per-process `?token=`, the token in the journal, and the `crypto.randomUUID` crash on plain HTTP.

| | |
| --- | --- |
| Package | `@lvxianchao/dsh-web-guard` (npm, MIT) |
| Current version | 3.0.0 |
| Runtime | Node.js >= 22.19, DSH >= 0.2.2-rc.1 (`engines.dsh`), zero runtime dependencies |
| Sources | TypeScript in `src/`; `lib/` is the committed build output |
| Install target | a DSH profile's bundle list (`web` by default) |

## Install

```bash
dsh plugin --profile web add @lvxianchao/dsh-web-guard
dsh plugin --profile web add "github:lvxianchao/dsh-web-guard"      # from GitHub
dsh plugin --profile web add /path/to/dsh-web-guard                 # from a checkout
sudo systemctl restart dsh-web                                      # adapt to the deployment
```

The package declares `dsh.bundle`, so the guard row mounts automatically. Do not add a `cordis.patch.yml` row to install it — only to override config. The package also declares `dsh.client`, so the management page appears inside DSH Settings once the harness version is compatible.

## Verify

```bash
# the gate listens on 3081; anonymous requests get redirected to /login
curl -si http://127.0.0.1:3081/ | head -3

# the gate reports health
curl -s http://127.0.0.1:3081/__guard/health

# failures and slow requests are logged with this prefix
journalctl -u dsh-web --since -5min | grep '\[dsh-web-guard\]'
```

On first start a password is generated, printed once to the terminal, and stored hashed in `<profile>/data/dsh-web-guard.json` (mode `0600`). The real end-to-end check is a browser login on `/login`, then **Settings → DSH Web Guard** in the harness.

## Configure

Profile patch: `~/.dsh/profiles/web/cordis.patch.yml`.

```yaml
- id: guard
  config:
    listenHost: '0.0.0.0'
    listenPort: 3081
    passwordHash: 'scrypt$...'   # npm run build, then node -e "import('./lib/auth.js').then(m=>console.log(m.hashPassword(process.argv[1])))" 'pw'
    sessionDays: 7
    maxAttempts: 5
    lockMinutes: 5
    tls: { certFile: /path/fullchain.pem, keyFile: /path/privkey.pem }
```

A profile patch **replaces the whole `config` object**, so restate every key you need. Full key table: README.md → Configuration.

## Safety rules (read before changing anything)

- **Never remove or disable this plugin on a deployment that is exposed beyond loopback.** The gate is the only way in: `dsh plugin remove`, deleting the bundle entry, or `disabled: true` stops port 3081 from listening while DSH keeps running. See README.md → "⚠️ This is the front door".
- The harness itself must listen on loopback; otherwise clients bypass the gate through the LAN address.
- One password, one privilege level. Do not present or implement it as multi-user auth.
- The session cache holds SHA-256 digests, never tokens — keep it that way.
- The **server half** must keep working without the browser half. The client bundle only moves the settings surface; never gate authentication, forwarding, or the listener on client code.

## Develop

```bash
git checkout dev                 # main only ever carries released code
npm ci --ignore-scripts          # TypeScript + esbuild (build-time only)
npm run typecheck                # tsc for src/ (server) and src/client (no emit)
npm run build                    # src/ → lib/ (tsc + esbuild single-file client bundle)
```

The shadow instance reuses the real profile read-only, but its guard state must not
collide with the live one (`profileContext.patchPath` decides where state is read),
so run it with an isolated `DSH_HOME`:

```bash
cp -a ~/.dsh/profiles/web /tmp/dsh-shadow-home/profiles/web
cp dev.yml dev.local.yml          # point `name:` at /abs/path/dsh-web-guard/lib/index.js
DSH_HOME=/tmp/dsh-shadow-home dsh --profile web --patch ./dev.local.yml --host 127.0.0.1 --port 3099 --no-open
GUARD_URL=http://127.0.0.1:3100 GUARD_PASSWORD=dev-only-password node test/e2e.mjs
```

`test/e2e.mjs` submits one wrong password on purpose, so run it against a test instance when `maxAttempts` is low. `npm run test:unit` needs neither a harness nor a password and covers the forwarded header set; `npm test` runs both.

`lib/` is committed on purpose: npm tarballs, `github:` installs and checkout installs all serve the same prebuilt bytes. After changing `src/` run `npm run build` and commit `lib/`; CI fails when the artifacts are stale.

Release: bump `package.json` + add a CHANGELOG entry, `npm run build`, merge `dev` into `main` with `--ff-only`, tag `v<version>`, push the tag. CI builds before publishing (provenance on), and a tag that disagrees with `package.json` fails the run.

## Repository map

| Path | Role |
| --- | --- |
| `src/index.ts` | plugin body: config/state, router, JSON API, login form routes, gate listener |
| `src/proxy.ts` | upstream forwarding: the `Host` / `Origin` loopback rewrite and the `Referer` drop |
| `src/auth.ts` | scrypt password hashing and the session table (SHA-256 digests, persisted cache) |
| `src/page.ts`, `src/i18n.ts` | login / sign-out pages and en+zh strings (themed) |
| `src/inject.ts`, `src/polyfill.ts` | session watchdog (`/__guard/session` probe) and the secure-context polyfill injected into the index |
| `src/shared/api.ts` | JSON contract shared by the server and the settings page |
| `src/shared/theme.ts` | light/dark palettes for the standalone pages |
| `src/client/module.tsx` | `dsh.client` entry: registers the native settings section, icon, dictionaries, styles |
| `src/client/GuardSettings.tsx` | React settings page (policy, password, listener, sessions, sign-out) |
| `src/client/api.ts`, `locales.ts`, `styles.ts` | fetch wrapper, zh/en copy, token-based CSS |
| `scripts/build.mjs` | build: tsc for the server, esbuild for the single-file client bundle |
| `test/e2e.mjs` | live checks against a running gate (needs `GUARD_PASSWORD`) |
| `test/unit.mjs` | harness-free checks for the forwarded header set (`npm run test:unit`) |
| `lib/` | committed build output (`index.js` + `client.js`) |
| `docs/v3-architecture.md` | internal design note: slot contract, JSON API, work split |
| `dev.yml`, `dev.local.yml` | shadow-instance overlays (`dev.local.yml` is gitignored) |

Companion plugin: [dsh-video-preview](https://github.com/lvxianchao/dsh-video-preview) (streaming video preview for the same sidebar; independent install).
