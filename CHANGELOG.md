# Changelog

## 3.0.2 — 2026-11-10

### Fixed

- **The proxy no longer forwards the public `Referer` to the harness.** `Host` and `Origin` were rewritten to the loopback authority, but `Referer` was passed through verbatim, so the upstream still saw the address the browser used to reach the gate. A same-origin GET fetch sends no `Origin` — only `Referer` — so any plugin that adds its own "is this request from loopback" check (reading `Origin || Referer`) judged a legitimately forwarded request cross-origin and answered `403`: the plugin's settings page loaded, but every `GET /api/...` it issued failed within 1 ms while DSH itself kept working over `/api/remote.mux`. `referer` now joined `host`/`origin` in the dropped-header set. Dropping it rather than rewriting it is deliberate: the gate has already authenticated the request, and a fabricated loopback `Referer` would make a foreign document look same-origin.

### Upgrade

1. `dsh plugin --profile web add @lvxianchao/dsh-web-guard@3.0.2` (or reinstall from the same source you use).
2. `sudo systemctl restart dsh-web` (or however the harness is supervised). Sessions survive the restart; open pages reconnect on their own.

### Tests

- New `npm run test:unit` (`test/unit.mjs`) asserts the forwarded header set — loopback `Host`/`Origin`, no fabricated `Origin`, no `Referer`, hop-by-hop headers stripped — and runs in CI. `npm test` now runs it before `test/e2e.mjs`.

## 3.0.1 — 2026-11-10

### Fixed

- **The proxy no longer leaks upstream sockets when a browser disconnects.** Closing a tab, reloading or dropping the link mid-response left the upstream request alive; for a response that never ends — an SSE stream, a long poll — the socket stayed allocated in the shared keep-alive agent forever. Once `maxSockets` (128) of them had accumulated, every later request through the proxy queued until the reverse proxy in front gave up with `504` — while `/__guard/session` kept answering 200, which made it look like the harness was up. The guard now destroys the upstream request when the client closes and treats the resulting error as expected instead of logging it.
- **The launch-token exchange is bounded to 10 seconds.** An unanswered exchange used to stay `inflight` forever, stalling every request that awaited it.

### Upgrade

1. `dsh plugin --profile web add @lvxianchao/dsh-web-guard@3.0.1` (or reinstall from the same source you use).
2. `sudo systemctl restart dsh-web` (or however the harness is supervised). Sessions survive the restart; open pages reconnect on their own.

## 3.0.0 — 2026-11-06

### Breaking

- **Management moved into the harness.** The bottom-right shield button, its iframe overlay and the server-rendered `/__guard/admin` page are gone. A new `dsh.client` bundle registers a native **DSH Web Guard** page in the harness Settings panel (Settings → DSH Web Guard): password change, session lifetime, lockout threshold/duration, listener address/port, the live session list (per-device sign out, kick, sign out everywhere). `/login` and `/logout` stay standalone documents.
- **Requires DSH `0.2.2-rc.1` or newer** (`engines.dsh: >=0.2.2-rc.1 <0.3.0`). An incompatible host skips the whole bundle — for a front door that means the gate does not start at all, which is the safe direction; upgrade DSH before upgrading the plugin.
- **The sources are TypeScript now.** The published package still ships plain JS with zero runtime dependencies, so installing needs no toolchain; `npm run build` is a maintainer command.

### Added

- Native settings page in the harness, rendering inside the host React tree so it inherits the harness light/dark theme, scrolling, focus handling and mobile layout.
- JSON API behind it (`/__guard/api/state|settings|password|kick|logout-all`) with strict validation, contract error codes and the same CSRF checks as the login form.
- Login and sign-out pages follow the harness light/dark preference (the `ui-theme` row the Appearance control writes into the profile patch), fall back to the operating system when that preference is `system`/unset, and accept `?theme=light|dark` as an explicit override.
- "Restart to apply" is surfaced explicitly: listener changes are saved and reported as configured values plus a pending-restart flag instead of appearing to be lost.

### Changed

- The locale reader now shares a generic profile-preference reader with the new theme reader.
- The plain-HTTP `crypto.randomUUID` shim and the dead-session watchdog in the served index are unchanged; everything else that used to be injected is removed.
- Settings page copy is localised (English and Chinese) and follows the harness language.

### Removed

- The injected fallback shield/overlay entry and the server-rendered `/__guard/admin` document, together with the `/__guard/kill` and `/__guard/logout-all` form routes that only fed it.
- Admin-only server copy and the old admin screenshots.

### Upgrade

1. `dsh plugin --profile web add @lvxianchao/dsh-web-guard@3.0.0` (or reinstall from the same source you use).
2. `sudo systemctl restart dsh-web` (or however the harness is supervised).
3. Open **Settings → DSH Web Guard**. The password hash, session cache and settings file keep their v2 layouts, so the upgrade signs nobody out and your configuration carries over.

### Internal

- Build: `tsc` for the server half, `esbuild` for the single-file client bundle; `lib/` is committed so npm, `github:` and checkout installs all serve the same prebuilt bytes, and CI rejects stale artifacts.
- CI: typecheck + build + artifact freshness on every push and pull request; the release workflow builds before publishing.

## 2.1.1 — 2026-11-05

### Docs

- README and the admin page now describe the persisted session cache and the dead-session redirect; both still claimed sessions lived in memory and that a restart signed everyone out.
- Screenshots re-shot with the corrected wording.


## 2.1.0 — 2026-11-05

### Added

- **Sessions survive a restart.** The table is cached beside the password file (`dsh-web-guard-sessions-<port>.json`, mode 0600, atomic write), so upgrading or restarting DSH no longer signs every browser out — the open tab reconnects instead of hanging on "reconnecting". Rows that expired while the process was down are dropped on load.
- **Dead-session redirect.** The injected client probes the new `/__guard/session` endpoint (200 = live, 401 = gone) when the tab becomes visible, when the browser comes back online, after a WebSocket close, and every 30s. A 401 sends the browser to the login page with `?next=`, so a genuine revocation (password change, sign-out-all) looks like a login prompt rather than a dead spinner.

### Changed

- Restarting the guard is no longer a way to sign everyone out. Use the admin page's "sign out all devices" — revocation is an explicit action now.

### Security

- The session cache stores SHA-256 hashes, never raw tokens. Neither the file nor a heap dump can mint a working cookie.


## 2.0.1 — 2026-11-05

### Internal

- Publishing is automatic: pushing a `v*` tag publishes to npm from GitHub Actions through an OIDC trusted publisher, with provenance. A mismatched tag/version fails the run instead of shipping the wrong thing.


## 2.0.0 — 2026-11-05

### Breaking

- Renamed the package to `@lvxianchao/dsh-web-guard` (was `dsh-guard`) and the on-disk state file to `dsh-web-guard.json`. An old `dsh-guard.json` is **not** migrated: the gate generates a fresh password on first start and logs it once.
- The display name is now **DSH Web Guard** everywhere — login page, sign-out page, admin page, log prefix and health payload.

### Added

- Localised plugin metadata via `locale/en.json` and `locale/zh.json`, so the DSH plugin list shows a translated title and description.
- The settings page opens in an overlay instead of navigating away, and closes only from its own Close button.
- Header actions on the settings page are real buttons; the repository link moved into the title.
- README (both languages): an explicit warning against disabling or uninstalling the gate, and recovery steps for when it has already happened.

## 1.0.0 — 2026-11-04

First stable release.

### Features

- **Password gate** — scrypt-hashed password, revocable sessions with sliding expiry, per-IP lockout after repeated failures.
- **Reverse proxy that removes the 403** — forwards to the harness listener with `Host`/`Origin` rewritten to the loopback authority, which the `/api` browser-trust fence accepts by design.
- **Automatic launch-token exchange** — the harness session cookie is minted in-process and injected upstream; the browser never sees a token and there is nothing to dig out of the journal.
- **Secure-context polyfill** — `crypto.randomUUID` shim for plain-HTTP deployments, where the real API is unavailable outside a secure context.
- **Admin page** at `/__guard/admin` — change the password (current password required), session lifetime, lockout threshold and duration, listener address/port, view and kick live sessions, sign out everywhere. Reachable from the shield button in the harness UI.
- **Localisation** — login, admin and sign-out pages follow the harness language setting (Chinese and English).
- **Optional native TLS** — `tls.certFile` / `tls.keyFile`; otherwise run behind NPM, Caddy or any TLS-terminating proxy.
- **Zero runtime dependencies** — Node standard library only, no build step.

### Configuration precedence

`$DSH_HOME/dsh-guard.json` (written by the admin page) → plugin config in `cordis.patch.yml` → built-in defaults.

### Known limitations

- Single password, single privilege level — not a multi-user system.
- Listener address/port changes require a DSH restart.
- Sessions live in memory; a DSH restart signs everyone out.
- The harness itself must listen on loopback, otherwise the gate can be bypassed by connecting to its port directly.
