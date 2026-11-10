/**
 * dsh-web-guard — a password-gated front door for the DeepSeek Harness Web UI.
 *
 * Why this exists: the harness authenticates browsers with a per-process launch
 * token that is only printed to the operator's terminal, and its /api fence
 * rejects any proxy that rewrites Host. Both are correct for a local tool and
 * awkward for a service. This plugin listens on its own port, authenticates a
 * human with one password, then forwards to the loopback listener with Host and
 * Origin rewritten — which the fence accepts by design — while injecting the
 * harness cookie the browser never sees.
 *
 * v3 adds a JSON API under /__guard/api for the native settings page. The API
 * and the server-rendered form routes share one set of mutators, so behaviour
 * cannot drift; the JSON contract lives in src/shared/api.ts.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createListener, forward, forwardUpgrade, upstreamAgent } from './proxy.js';
import { hashPassword, verifyPassword, SessionStore } from './auth.js';
import { loginPage, logoutPage } from './page.js';
import { injectUi } from './inject.js';
import { createLocaleReader, normalize, t } from './i18n.js';
import { createPreferenceReader } from './preferences.js';
import { GUARD_API } from './shared/api.js';
export const name = 'dsh-web-guard';
export const inject = ['webServer', 'connection'];
const COOKIE = 'dsh_guard';
const MAX_FORM = 8 * 1024;
const MAX_BODY = 8 * 1024;
const DEFAULTS = {
    listenHost: '0.0.0.0',
    listenPort: 3081,
    sessionDays: 7,
    polyfill: true,
    title: 'DSH Web Guard',
    repo: 'https://github.com/lvxianchao/dsh-web-guard',
    password: '',
    passwordHash: '',
    maxAttempts: 5,
    lockMinutes: 5,
    tls: null,
};
/**
 * Guard state (password hash + settings) belongs to one profile:
 * several profiles can run this plugin and must not share a port or a password.
 * Reading prefers the profile-local file, then the legacy
 * $DSH_HOME/dsh-web-guard.json written by earlier versions; writes always use the
 * profile-local path.
 */
function legacyStatePath() {
    return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-web-guard.json');
}
function statePath(profileDir) {
    return join(profileDir, 'data', 'dsh-web-guard.json');
}
/**
 * Session cache lives beside the password but keyed by listener port: a shadow
 * instance (dev.yml, port 3100) runs against the same profile and must not
 * fight the live one over one file. Ports are exclusive, so this is a safe key.
 */
function sessionsPath(profileDir, port) {
    return join(profileDir, 'data', `dsh-web-guard-sessions-${port}.json`);
}
function readState(profileDir) {
    for (const path of [statePath(profileDir), legacyStatePath()]) {
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            if (parsed !== null && typeof parsed === 'object')
                return parsed;
        }
        catch {
            /* try the next location */
        }
    }
    return {};
}
function writeState(profileDir, state) {
    const path = statePath(profileDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
    // One-time migration: once this profile owns a local state file, the shared
    // legacy file must go, or the next profile to start would inherit this
    // profile's port and password.
    const legacy = legacyStatePath();
    if (legacy !== path) {
        try {
            rmSync(legacy);
        }
        catch {
            /* already gone */
        }
    }
}
/** Generate a memorable-but-strong password (base32-ish, no ambiguous chars). */
function randomPassword() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(16);
    let out = '';
    for (let i = 0; i < 16; i++)
        out += alphabet[bytes[i] % alphabet.length];
    return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}
function parseCookies(header) {
    const out = {};
    if (typeof header !== 'string')
        return out;
    for (const part of header.split(';')) {
        const at = part.indexOf('=');
        if (at === -1)
            continue;
        out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
    }
    return out;
}
function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0)
        return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
}
function send(res, status, headers, body) {
    res.writeHead(status, headers);
    res.end(body);
}
const json = (res, status, payload) => send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(payload));
const html = (res, status, body) => send(res, status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body);
const redirect = (res, location) => send(res, 302, { location, 'cache-control': 'no-store' }, '');
/**
 * Same-origin check for state-changing form posts.
 *
 * Compares hostnames only: a TLS-terminating proxy commonly forwards `Host`
 * without the public port while the browser's Origin still carries it, so a
 * strict host:port comparison would reject every proxied login. SameSite=Lax
 * on the session cookie remains the primary CSRF defence.
 */
function originAllowed(req) {
    const origin = req.headers.origin;
    if (origin === undefined)
        return true; // non-browser client; password still required
    try {
        const parsed = new URL(origin);
        const host = String(req.headers.host ?? '').toLowerCase();
        const hostname = host.includes(']') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
        return parsed.hostname.toLowerCase() === hostname;
    }
    catch {
        return false;
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isApiPath(path) {
    return path === '/__guard/api' || path.startsWith('/__guard/api/');
}
export function apply(ctx, config = {}) {
    // Precedence: file-managed settings (written by the settings page) > plugin
    // config in cordis.patch.yml > built-in defaults.
    const patchPath = ctx.profileContext?.patchPath
        ?? ctx.get?.('profileContext')?.patchPath
        ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml');
    const profileDir = dirname(patchPath);
    const state = readState(profileDir);
    const persisted = state.settings ?? {};
    const cfg = { ...DEFAULTS, ...config, ...persisted };
    // Write straight to the process streams: cordis loggers can swallow lines
    // depending on level, and the generated password must never be lost.
    const log = (line) => console.log(`[dsh-web-guard] ${line}`);
    const warn = (line) => console.error(`[dsh-web-guard] ${line}`);
    // ── password resolution: hash > plaintext > generated-and-persisted ────────
    let passwordHash = cfg.passwordHash || '';
    if (!passwordHash && cfg.password) {
        passwordHash = hashPassword(String(cfg.password));
        log('password taken from plugin config');
    }
    if (!passwordHash) {
        passwordHash = typeof state.passwordHash === 'string' ? state.passwordHash : '';
    }
    if (!passwordHash) {
        const generated = randomPassword();
        passwordHash = hashPassword(generated);
        writeState(profileDir, { ...state, passwordHash, createdAt: new Date().toISOString() });
        log(`no password configured — generated one and saved to ${statePath(profileDir)}`);
        log(`PASSWORD: ${generated}`);
    }
    const sessions = new SessionStore({
        sessionDays: Number(cfg.sessionDays),
        maxAttempts: Number(cfg.maxAttempts),
        lockMinutes: Number(cfg.lockMinutes),
        file: sessionsPath(profileDir, Number(cfg.listenPort)),
    });
    // Restore sessions from the previous process: a restart (upgrade, config
    // change) must not sign every browser out. Expired rows are dropped on load.
    sessions.load();
    // Locale follows the harness: its language picker writes `preference` into
    // the profile patch file. Event-driven: no filesystem work on the request path.
    const localeReader = createLocaleReader(patchPath);
    // The Appearance control writes `- id: ui-theme` → `config.preference` into
    // the same patch file. Reading it lets the login/sign-out documents follow
    // the operator's harness choice before the harness page exists; `system` and
    // a missing row leave them on `prefers-color-scheme`.
    const themeReader = createPreferenceReader(patchPath, 'ui-theme');
    const harnessTheme = () => themeReader.get();
    function localeFor(req) {
        const explicit = localeReader.get();
        if (explicit)
            return explicit;
        const header = String(req?.headers?.['accept-language'] ?? '');
        return normalize(header.split(',')[0]?.trim()) || 'en';
    }
    const targetOrigin = ctx.webServer.getOrigin();
    const upstream = new URL(targetOrigin);
    const listenPort = Number(cfg.listenPort);
    if (listenPort === Number(upstream.port || 80)) {
        throw new Error(`dsh-web-guard: listenPort ${listenPort} collides with the harness listener ${targetOrigin}`);
    }
    const secureCookie = Boolean(cfg.tls?.certFile && cfg.tls?.keyFile);
    // The listener binds once at boot. Settings surfaces (native page, JSON API)
    // settings page, JSON API) report the *configured* values and flag a pending
    // restart when they disagree with what is actually listening, so saving a new
    // port shows up immediately instead of appearing to be lost.
    const runningListener = { host: String(cfg.listenHost), port: Number(cfg.listenPort) };
    const configuredListener = { host: String(cfg.listenHost), port: Number(cfg.listenPort) };
    const listenerRestartRequired = () => configuredListener.host !== runningListener.host || configuredListener.port !== runningListener.port;
    // ── harness cookie: exchanged in-process, never exposed to the browser ─────
    let cookieCache = { value: '', at: 0 };
    let inflight = null;
    async function harnessCookie(force = false) {
        if (!force && cookieCache.value && Date.now() - cookieCache.at < 30 * 60 * 1000)
            return cookieCache.value;
        if (inflight)
            return inflight;
        const pending = (async () => {
            try {
                const url = ctx.connection.authenticatedUrl(`${targetOrigin}/`);
                // Bound the exchange: an unanswered fetch would otherwise stay
                // `inflight` forever and stall every request that awaits it.
                const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
                const parts = res.headers.getSetCookie();
                const value = parts.map((line) => line.split(';')[0]).filter(Boolean).join('; ');
                if (!value)
                    throw new Error(`launch-token exchange returned ${res.status} without a cookie`);
                cookieCache = { value, at: Date.now() };
                log('harness session cookie exchanged');
                return value;
            }
            finally {
                inflight = null;
            }
        })();
        inflight = pending;
        return pending;
    }
    function sessionOf(req) {
        const token = parseCookies(req.headers.cookie)[COOKIE];
        if (!token)
            return undefined;
        const row = sessions.resolve(token);
        if (!row)
            return undefined;
        return { token, row };
    }
    function setSessionCookie(res, token) {
        const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
        if (Number(cfg.sessionDays) > 0)
            attrs.push(`Max-Age=${Math.floor(Number(cfg.sessionDays) * 86400)}`);
        if (secureCookie)
            attrs.push('Secure');
        res.setHeader('set-cookie', attrs.join('; '));
    }
    function clearSessionCookie(res) {
        const attrs = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
        if (secureCookie)
            attrs.push('Secure');
        res.setHeader('set-cookie', attrs.join('; '));
    }
    function currentSettings() {
        return {
            sessionDays: Number(cfg.sessionDays),
            maxAttempts: Number(cfg.maxAttempts),
            lockMinutes: Number(cfg.lockMinutes),
            listenHost: configuredListener.host,
            listenPort: configuredListener.port,
            title: String(cfg.title),
            repo: String(cfg.repo),
        };
    }
    function persistGuardState() {
        const settings = {
            sessionDays: Number(cfg.sessionDays),
            maxAttempts: Number(cfg.maxAttempts),
            lockMinutes: Number(cfg.lockMinutes),
            listenHost: configuredListener.host,
            listenPort: configuredListener.port,
        };
        writeState(profileDir, { ...readState(profileDir), passwordHash, settings });
    }
    // ── shared mutators: form routes and JSON API must not drift ──────────────
    /** Apply a validated settings change; listener values need a restart. */
    function updateSettings(input) {
        const sessionDays = input.sessionDays ?? Number(cfg.sessionDays);
        const maxAttempts = input.maxAttempts ?? Number(cfg.maxAttempts);
        const lockMinutes = input.lockMinutes ?? Number(cfg.lockMinutes);
        configuredListener.host = input.listenHost ?? configuredListener.host;
        configuredListener.port = input.listenPort ?? configuredListener.port;
        // Hot-reloadable values apply in place; listener values are persisted for
        // the next boot and the surfaces report the configured value with a
        // restart notice until the running gate matches it.
        cfg.sessionDays = sessionDays;
        cfg.maxAttempts = maxAttempts;
        cfg.lockMinutes = lockMinutes;
        sessions.sessionMs = sessionDays * 24 * 60 * 60 * 1000;
        sessions.maxAttempts = maxAttempts;
        sessions.lockMs = lockMinutes * 60 * 1000;
        persistGuardState();
        const restartRequired = listenerRestartRequired();
        log(`settings updated${restartRequired ? ' — restart required for listener changes' : ''}`);
        return { settings: currentSettings(), restartRequired };
    }
    /** Validate and apply a password change; returns the error code or null. */
    function changePassword(current, next, confirm) {
        if (!verifyPassword(current, passwordHash))
            return 'wrong_current';
        if (next.length < 6)
            return 'too_short';
        if (next !== confirm)
            return 'mismatch';
        passwordHash = hashPassword(next);
        persistGuardState();
        log('password changed');
        return null;
    }
    /** Revoke one session; false when the id is unknown or already gone. */
    function kickSession(id) {
        const removed = sessions.removeById(id);
        log(`session revoked from the settings page: ${id.slice(0, 8)}… ${removed ? 'ok' : 'not found'}`);
        return removed;
    }
    function revokeAllSessions() {
        sessions.revokeAll();
        log('all sessions revoked from the settings page');
    }
    // ── request handling: form routes ─────────────────────────────────────────
    async function handleLogin(req, res, locale, search) {
        const ip = clientIp(req);
        if (sessions.isLocked(ip)) {
            return html(res, 429, loginPage({ title: cfg.title, locked: true, repo: cfg.repo, locale, search, themePreference: harnessTheme() }));
        }
        if (!originAllowed(req)) {
            return html(res, 403, loginPage({ title: cfg.title, error: t(locale).errOrigin, repo: cfg.repo, locale, search, themePreference: harnessTheme() }));
        }
        const body = await readBody(req).catch(() => '');
        const form = new URLSearchParams(body);
        const password = form.get('password') ?? '';
        const next = form.get('next') ?? '/';
        const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
        if (!verifyPassword(password, passwordHash)) {
            const left = sessions.recordFailure(ip);
            log(`login failed from ${ip} (${left} attempts left)`);
            return html(res, 401, loginPage({
                title: cfg.title,
                error: left > 0 ? t(locale).errWrong : t(locale).errLocked,
                next: safeNext,
                repo: cfg.repo,
                locale,
                search,
                themePreference: harnessTheme(),
            }));
        }
        sessions.clearFailures(ip);
        const token = sessions.issue(ip, String(req.headers['user-agent'] ?? ''));
        setSessionCookie(res, token);
        log(`login ok from ${ip}`);
        redirect(res, safeNext);
    }
    // ── JSON API (native settings page) ───────────────────────────────────────
    function apiError(res, status, error, extra = {}) {
        const payload = { ok: false, error };
        if (extra.field !== undefined)
            payload.field = extra.field;
        if (extra.detail !== undefined)
            payload.detail = extra.detail;
        json(res, status, payload);
    }
    function methodNotAllowed(res, allow) {
        send(res, 405, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            allow,
        }, JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    }
    /**
     * Mutating API routes refuse anything a cross-site page could send: a JSON
     * content type (which forces a CORS preflight) and an explicit same-host
     * Origin (a non-browser client must restate it).
     *
     * `logout-all` carries no body, so a browser client that sends no
     * `content-type` there is accepted (an explicit form content type is still
     * rejected); the Origin check is the effective defence for that route.
     */
    function mutationForbidden(req, requireJson = true) {
        const origin = req.headers.origin;
        if (typeof origin !== 'string' || !originAllowed(req))
            return 'forbidden';
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (requireJson ? type !== 'application/json' : type !== '' && type !== 'application/json')
            return 'forbidden';
        return null;
    }
    async function readJsonBody(req) {
        let raw;
        try {
            raw = await readBody(req, MAX_BODY);
        }
        catch {
            return undefined;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return undefined;
        }
        return isRecord(parsed) ? parsed : undefined;
    }
    function stateResponse(session) {
        const currentId = sessions.idOf(session.token);
        const rows = sessions.list().map((row) => ({ ...row, current: row.id === currentId }));
        return { ok: true, settings: currentSettings(), sessions: rows, restartRequired: listenerRestartRequired() };
    }
    function apiSettings(res, body) {
        const input = {};
        const intFields = [
            ['sessionDays', 0, 365],
            ['maxAttempts', 1, 50],
            ['lockMinutes', 1, 1440],
            ['listenPort', 1, 65535],
        ];
        for (const [field, min, max] of intFields) {
            const value = body[field];
            if (value === undefined)
                continue;
            if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
                return apiError(res, 400, 'invalid_field', { field });
            }
            input[field] = value;
        }
        if (body.listenHost !== undefined) {
            if (typeof body.listenHost !== 'string')
                return apiError(res, 400, 'invalid_field', { field: 'listenHost' });
            const listenHost = body.listenHost.trim();
            if (listenHost.length === 0 || listenHost.length > 64)
                return apiError(res, 400, 'invalid_field', { field: 'listenHost' });
            input.listenHost = listenHost;
        }
        const result = updateSettings(input);
        const payload = { ok: true, settings: result.settings, restartRequired: result.restartRequired };
        json(res, 200, payload);
    }
    function apiPassword(res, body) {
        const request = body;
        for (const field of ['current', 'next', 'confirm']) {
            if (typeof request[field] !== 'string')
                return apiError(res, 400, 'invalid_field', { field });
        }
        const code = changePassword(request.current, request.next, request.confirm);
        if (code)
            return apiError(res, 400, code);
        const payload = { ok: true };
        json(res, 200, payload);
    }
    function apiKick(res, body) {
        const id = body.id;
        if (typeof id !== 'string' || id.length === 0)
            return apiError(res, 400, 'invalid_field', { field: 'id' });
        if (!kickSession(id))
            return apiError(res, 404, 'kick_missing');
        const payload = { ok: true };
        json(res, 200, payload);
    }
    function apiLogoutAll(res) {
        revokeAllSessions();
        clearSessionCookie(res);
        const payload = { ok: true };
        json(res, 200, payload);
    }
    async function handleApi(req, res, path, session) {
        if (path === GUARD_API.state) {
            if (req.method !== 'GET')
                return methodNotAllowed(res, 'GET');
            return json(res, 200, stateResponse(session));
        }
        const known = path === GUARD_API.settings || path === GUARD_API.password || path === GUARD_API.kick || path === GUARD_API.logoutAll;
        if (!known)
            return apiError(res, 404, 'not_found');
        if (req.method !== 'POST')
            return methodNotAllowed(res, 'POST');
        const forbidden = mutationForbidden(req, path !== GUARD_API.logoutAll);
        if (forbidden)
            return apiError(res, 403, forbidden);
        if (path === GUARD_API.logoutAll)
            return apiLogoutAll(res);
        const body = await readJsonBody(req);
        if (!body)
            return apiError(res, 400, 'invalid_body');
        if (path === GUARD_API.settings)
            return apiSettings(res, body);
        if (path === GUARD_API.password)
            return apiPassword(res, body);
        return apiKick(res, body);
    }
    // ── request router ────────────────────────────────────────────────────────
    async function handler(req, res) {
        const url = new URL(req.url ?? '/', 'http://guard.invalid');
        const path = url.pathname;
        const locale = localeFor(req);
        const search = url.search;
        if (path === '/__guard/health')
            return json(res, 200, { ok: true, service: 'dsh-web-guard' });
        // Authenticated probe: 200 when this browser still holds a live session,
        // 401 when it does not. The injected client uses it to leave the
        // "reconnecting" spinner for the login page instead of retrying forever.
        if (path === '/__guard/session') {
            return sessionOf(req) ? json(res, 200, { ok: true }) : json(res, 401, { ok: false });
        }
        if (path === '/login' && req.method === 'GET') {
            if (sessionOf(req))
                return redirect(res, '/');
            return html(res, 200, loginPage({ title: cfg.title, next: url.searchParams.get('next') ?? '/', repo: cfg.repo, locale, search, themePreference: harnessTheme() }));
        }
        if (path === '/login' && req.method === 'POST')
            return handleLogin(req, res, locale, search);
        if (path === '/logout') {
            const s = sessionOf(req);
            if (s)
                sessions.revoke(s.token);
            clearSessionCookie(res);
            return html(res, 200, logoutPage({ title: cfg.title, locale, search, themePreference: harnessTheme() }));
        }
        const session = sessionOf(req);
        if (!session) {
            // API routes never redirect: the settings page renders the 401 inline.
            if (isApiPath(path))
                return apiError(res, 401, 'unauthorized');
            if (path.startsWith('/api'))
                return json(res, 401, { error: 'unauthorized', login: '/login' });
            // Management paths reveal nothing to anonymous visitors: no `next` echo.
            if (path.startsWith('/__guard/'))
                return redirect(res, '/login');
            const next = encodeURIComponent(url.pathname + url.search);
            return redirect(res, `/login?next=${next}`);
        }
        if (isApiPath(path))
            return handleApi(req, res, path, session);
        // No server-rendered management page: the native settings page talks to
        // the JSON API, and anything else under the guard namespace is unknown.
        if (path.startsWith('/__guard/'))
            return apiError(res, 404, 'not_found');
        let cookie;
        try {
            cookie = await harnessCookie();
        }
        catch (err) {
            warn(`harness cookie unavailable: ${err instanceof Error ? err.message : String(err)}`);
            return json(res, 503, { error: 'harness_unavailable', detail: err instanceof Error ? err.message : String(err) });
        }
        forward(req, res, { targetOrigin, cookie, agent: upstreamAgent, log });
    }
    function onUpgrade(req, socket, head) {
        if (!sessionOf(req)) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            return;
        }
        harnessCookie()
            .then((cookie) => forwardUpgrade(req, socket, head, { targetOrigin, cookie, log }))
            .catch((err) => {
            warn(`upgrade blocked: ${err instanceof Error ? err.message : String(err)}`);
            socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        });
    }
    // ── wiring ────────────────────────────────────────────────────────────────
    // The polyfill and the session watchdog are injected unconditionally: the
    // polyfill switch must not also disable the dead-session redirect.
    ctx.effect(() => ctx.webServer.tapIndex((html) => injectUi(html, { polyfill: cfg.polyfill })), 'dsh-web-guard: index transform');
    const listener = createListener({
        host: String(cfg.listenHost),
        port: listenPort,
        tlsCert: cfg.tls?.certFile || null,
        tlsKey: cfg.tls?.keyFile || null,
        handler,
        onUpgrade,
        log,
    });
    ctx.effect(() => {
        listener.listen().then(() => {
            log(`listening on ${secureCookie ? 'https' : 'http'}://${cfg.listenHost}:${listenPort} -> ${targetOrigin}`);
            const bind = ctx.webServer.config?.host;
            if (typeof bind === 'string' && !isLoopback(bind)) {
                warn(`harness is bound to ${bind}; clients can bypass this gate by connecting there directly — bind it to 127.0.0.1`);
            }
        }, (err) => warn(`listen failed on ${cfg.listenHost}:${listenPort}: ${err.message}`));
        return () => {
            sessions.dispose();
            localeReader.dispose();
            themeReader.dispose();
            listener.close();
        };
    }, 'dsh-web-guard: listener');
    return { stop: () => listener.close() };
}
function isLoopback(host) {
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
}
function readBody(req, limit = MAX_FORM) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
