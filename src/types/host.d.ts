/**
 * The slice of the Cordis Host context this plugin consumes.
 *
 * These interfaces are deliberately local and structural instead of imported
 * from @deepseek-ai/dsh-*: the runtime is the authority, the packages are
 * release candidates, and a published plugin must not fail to build because an
 * upstream type moved. Every member below is used by the plugin and is
 * exercised by the shadow-instance check.
 */
export interface WebServerService {
  /** Origin of the loopback harness listener, e.g. `http://127.0.0.1:3080`. */
  getOrigin(): string
  /** Raw index transform hook; the returned disposer removes the transform. */
  tapIndex(transform: (html: string) => string): () => void
  /** The harness listener binding, used for the "bind it to loopback" warning. */
  readonly config?: { readonly host?: string }
}

export interface ConnectionService {
  /**
   * Wrap a URL with the launch token the harness issued to this process.
   * Present on the 0.2.2 line only — 0.2.3 removed it in favour of the
   * credential-verifier registry below.
   */
  authenticatedUrl?(url: string): string
  /**
   * Create an in-process Peer (0.2.3+). Its `principal.kind` fixes the identity
   * every call through it speaks for; `owner` is what the harness itself uses
   * for its shared browser Peer.
   */
  createPeer?(options: { readonly principal: { readonly kind: 'owner' } }): unknown
}

/**
 * Registry of credential verifiers introduced in 0.2.3 (`connection.authentication`).
 * The harness asks every registration in order and adopts the first live Peer,
 * so a plugin that returns one admits its own requests without touching the
 * launch token or a harness cookie. Absent on the 0.2.2 line.
 */
export interface AuthenticationRegistry {
  register(provider: {
    authenticate(request: {
      readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
    }): unknown
  }): () => Promise<void>
}

export interface ProfileContext {
  /** Absolute path of the profile patch file the process was started with. */
  readonly patchPath: string
}

export interface HostContext {
  readonly webServer: WebServerService
  readonly connection: ConnectionService
  /** Present only in a profile launched by `dsh`. */
  readonly profileContext?: ProfileContext
  /** Profile-boot escape hatch some hosts expose for `profileContext`. */
  get?(name: string): unknown
  /** Run `callback` now and dispose its return value when this plugin unloads. */
  effect(callback: () => void | (() => void), label?: string): () => void
}
