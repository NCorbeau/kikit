import {
  DEV_ACCOUNT_ID,
  DEV_PAGE_ID,
  DOCUMENT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  serverMessageSchema,
  decodeUpdate,
  MAX_PRESENCE_SNAPSHOT_BYTES,
  pageSessionSchema,
  type ClientMessage,
  type ServerMessage,
} from '@kikit/contracts';

export type Connection = 'connecting' | 'online' | 'offline' | 'error';
interface Callbacks {
  connection(state: Connection): void;
  message(message: ServerMessage): Promise<void>;
  error(message: string, terminal: boolean): void;
  presence?(update: Uint8Array): void;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 1_000;

/** Only transport/reconnect. Durable outbound identities belong to DocumentSession. */
export class SyncClient {
  private socket?: WebSocket;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private sessionRequest?: AbortController;
  private generation = 0;
  private stopped = true;
  private terminal = false;
  private messageChain = Promise.resolve();

  constructor(private readonly callbacks: Callbacks, private readonly identity: { accountId: string; pageId: string; fixture?: boolean } = { accountId: DEV_ACCOUNT_ID, pageId: DEV_PAGE_ID, fixture: true }) {}

  private onOnline = (): void => this.connect();
  private onOffline = (): void => {
    this.disconnect();
    this.callbacks.connection('offline');
  };

  start(): void {
    this.stopped = false;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    this.connect();
  }

  retry(): void {
    this.terminal = false;
    this.connect();
  }

  private disconnect(): void {
    // Invalidate callbacks before closing; close/error events can run immediately.
    this.generation++;
    clearTimeout(this.connectionTimer);
    this.sessionRequest?.abort();
    this.socket?.close();
    this.socket = undefined;
  }

  reconnect(): void {
    this.disconnect();
    if (this.stopped || this.terminal) return;
    this.callbacks.connection('offline');
    this.connectionTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  stopWithError(): void {
    this.terminal = true;
    this.disconnect();
    this.callbacks.connection('error');
  }

  private connect(): void {
    if (this.stopped || this.terminal) return;
    this.disconnect();
    if (!navigator.onLine) {
      this.callbacks.connection('offline');
      return;
    }
    const generation = this.generation;
    this.callbacks.connection('connecting');
    this.sessionRequest = new AbortController();
    // Bound an unreachable HTTP endpoint as well as a silent WebSocket handshake.
    this.connectionTimer = setTimeout(() => {
      if (generation === this.generation) this.reconnect();
    }, HANDSHAKE_TIMEOUT_MS);
    void this.establish(generation, this.sessionRequest.signal);
  }

  private async establish(generation: number, signal: AbortSignal): Promise<void> {
    try {
      const response = await fetch(this.identity.fixture ? '/api/dev/session' : `/api/pages/${this.identity.pageId}/session`, {
        signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (generation !== this.generation) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          this.rejectHttpSession(response.status);
          return;
        }
        throw new Error('The server is unavailable.');
      }
      const pageSession = pageSessionSchema.safeParse(await response.json());
      if (generation !== this.generation) return;
      if (!pageSession.success || !this.matchesMountedPage(pageSession.data)) {
        this.fail('The server identity or document version changed. Your local work has been preserved.');
        return;
      }
      this.openSocket(generation);
    } catch {
      if (generation === this.generation) this.reconnect();
    }
  }

  private rejectHttpSession(status: number): void {
    this.fail('Page access is unavailable. Your local work has been preserved.');
    if (this.identity.fixture) return;
    if (status === 401) window.dispatchEvent(new Event('kikit-session-ended'));
    if (status === 403) this.notifyPageAccessLost();
  }

  private matchesMountedPage(pageSession: ReturnType<typeof pageSessionSchema.parse>): boolean {
    return pageSession.accountId === this.identity.accountId
      && pageSession.pageId === this.identity.pageId
      && pageSession.protocolVersion === PROTOCOL_VERSION
      && pageSession.schemaVersion === DOCUMENT_SCHEMA_VERSION;
  }

  private openSocket(generation: number): void {
    const url = new URL('/api/sync', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.send({
        type: 'hello',
        pageId: this.identity.pageId,
        accountId: this.identity.accountId,
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
      });
    };
    socket.onmessage = event => this.enqueueMessage(event.data, generation);
    socket.onclose = () => {
      if (generation === this.generation) this.reconnect();
    };
    socket.onerror = () => {
      if (generation === this.generation) this.reconnect();
    };
  }

  private enqueueMessage(data: unknown, generation: number): void {
    if (generation !== this.generation) return;
    let message: ServerMessage;
    try {
      message = parseServerMessage(data);
      // Cursor traffic never waits on IndexedDB or enters document persistence.
      if (message.type === 'presence') {
        this.deliverPresence(message);
        return;
      }
    } catch (error) {
      this.enqueueProtocolFailure(error, generation);
      return;
    }
    this.enqueueOrderedMessage(message, generation);
  }

  private deliverPresence(message: Extract<ServerMessage, { type: 'presence' }>): void {
    const update = decodeUpdate(message.update);
    if (update.byteLength > MAX_PRESENCE_SNAPSHOT_BYTES) throw new Error('The server sent unsupported presence.');
    this.callbacks.presence?.(update);
  }

  private enqueueProtocolFailure(error: unknown, generation: number): void {
    // Keep terminal protocol failure behind any already admitted durable
    // hydration; it must not be overwritten by that transaction completing.
    this.messageChain = this.messageChain.then(() => {
      if (generation === this.generation) this.fail(error instanceof Error ? error.message : 'Could not read the server response.');
    }).catch(() => {
      if (generation === this.generation) this.fail('Could not read the server response.');
    });
  }

  private enqueueOrderedMessage(message: ServerMessage, generation: number): void {
    // Ordered delivery includes the session's asynchronous local persistence.
    this.messageChain = this.messageChain.then(async () => {
      if (generation !== this.generation) return;
      await this.callbacks.message(message);
      if (!this.identity.fixture && message.type === 'error' && message.code === 'ACCESS_DENIED') {
        this.notifyPageAccessLost();
      }
      if (message.type === 'sync' && generation === this.generation) {
        clearTimeout(this.connectionTimer);
      }
    }).catch(error => {
      if (generation !== this.generation) return;
      this.fail(error instanceof Error ? error.message : 'Could not read the server response.');
    });
  }

  private notifyPageAccessLost(): void {
    window.dispatchEvent(new CustomEvent('kikit-access-lost', { detail: { pageId: this.identity.pageId } }));
    window.dispatchEvent(new Event('kikit-session-ended'));
  }

  private fail(message: string): void {
    this.callbacks.error(message, true);
    this.stopWithError();
  }

  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      this.reconnect();
      return false;
    }
  }

  destroy(): void {
    this.stopped = true;
    this.disconnect();
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
  }
}

function parseServerMessage(data: unknown): ServerMessage {
  const parsed = serverMessageSchema.safeParse(JSON.parse(String(data)));
  if (!parsed.success) throw new Error('The server sent an unsupported response. Your local work has been preserved.');
  return parsed.data;
}
