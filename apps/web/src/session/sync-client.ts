import {
  DEV_ACCOUNT_ID, DEV_PAGE_ID, DOCUMENT_SCHEMA_VERSION, PROTOCOL_VERSION,
  serverMessageSchema, type ClientMessage, type DevSession, type ServerMessage,
} from '@kikit/contracts';

export type Connection = 'connecting' | 'online' | 'offline' | 'error';
interface Callbacks {
  connection(state: Connection): void;
  message(message: ServerMessage): Promise<void>;
  error(message: string, terminal: boolean): void;
}

/** Only transport/reconnect. Durable outbound identities belong to DocumentSession. */
export class SyncClient {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private generation = 0;
  private stopped = true;
  private terminal = false;
  private messages = Promise.resolve();
  private onOnline = () => this.connect();
  private onOffline = () => { this.disconnect(); this.callbacks.connection('offline'); };

  constructor(private callbacks: Callbacks) {}

  start(): void {
    this.stopped = false;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    this.connect();
  }

  retry(): void { this.terminal = false; this.connect(); }

  private disconnect(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.socket?.close();
    this.socket = undefined;
  }

  reconnect(): void {
    this.disconnect();
    if (this.stopped || this.terminal) return;
    this.callbacks.connection('offline');
    this.timer = setTimeout(() => this.connect(), 1000);
  }

  stopWithError(): void {
    this.terminal = true;
    this.disconnect();
    this.callbacks.connection('error');
  }

  private connect(): void {
    if (this.stopped || this.terminal) return;
    this.disconnect();
    if (!navigator.onLine) { this.callbacks.connection('offline'); return; }
    const generation = this.generation;
    this.callbacks.connection('connecting');
    this.controller = new AbortController();
    // Bound an unreachable HTTP endpoint as well as a silent WebSocket handshake.
    this.timer = setTimeout(() => { if (generation === this.generation) this.reconnect(); }, 10000);
    void this.establish(generation, this.controller.signal);
  }

  private async establish(generation: number, signal: AbortSignal): Promise<void> {
    try {
      const response = await fetch('/api/dev/session', { signal, cache: 'no-store', credentials: 'same-origin' });
      if (generation !== this.generation) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          this.callbacks.error('Development page access is unavailable. Your local work has been preserved.', true);
          this.stopWithError();
          return;
        }
        throw new Error('The server is unavailable.');
      }
      const fixture = await response.json() as DevSession;
      if (generation !== this.generation) return;
      if (!fixture || fixture.accountId !== DEV_ACCOUNT_ID || fixture.pageId !== DEV_PAGE_ID || fixture.protocolVersion !== PROTOCOL_VERSION || fixture.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
        this.callbacks.error('The server identity or document version changed. Your local work has been preserved.', true);
        this.stopWithError();
        return;
      }
      const url = new URL('/api/sync', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        if (generation !== this.generation) return;
        this.send({ type: 'hello', pageId: DEV_PAGE_ID, protocolVersion: PROTOCOL_VERSION, schemaVersion: DOCUMENT_SCHEMA_VERSION });
      };
      socket.onmessage = event => {
        this.messages = this.messages.then(async () => {
          if (generation !== this.generation) return;
          const parsed = serverMessageSchema.safeParse(JSON.parse(String(event.data)));
          if (!parsed.success) throw new Error('The server sent an unsupported response. Your local work has been preserved.');
          await this.callbacks.message(parsed.data);
          if (parsed.data.type === 'sync' && generation === this.generation) clearTimeout(this.timer);
        }).catch(error => {
          if (generation !== this.generation) return;
          this.callbacks.error(error instanceof Error ? error.message : 'Could not read the server response.', true);
          this.stopWithError();
        });
      };
      socket.onclose = () => { if (generation === this.generation) this.reconnect(); };
      socket.onerror = () => { if (generation === this.generation) this.reconnect(); };
    } catch {
      if (generation === this.generation) this.reconnect();
    }
  }

  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { this.reconnect(); return false; }
  }

  destroy(): void {
    this.stopped = true;
    this.disconnect();
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
  }
}
