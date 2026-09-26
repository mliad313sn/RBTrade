import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { parseChannel, requiresMfa } from '@kora/domain';
import { decodeJwt } from 'jose';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';

import { ACCESS_COOKIE } from '../auth/cookies';
import type { Principal } from '../auth/principal';
import { TokenService } from '../auth/token.service';
import { ChannelHub, type HubClient } from './channel-hub';
import { InstrumentsRepository } from './instruments.repository';
import { MD_CONFIG, type MdConfig } from './md-config';

export const WS_PATH = '/ws';
const AUTH_TIMEOUT_MS = 5000;
const PING_MS = 30_000;
const OPS_WINDOW_MS = 10_000;
const OPS_PER_WINDOW = 60;

const channels = z.array(z.string().max(80)).min(1).max(100);
const id = z.union([z.string().max(64), z.number().int()]).optional();
const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('auth'), token: z.string().min(10).max(8192) }).strict(),
  z.object({ op: z.literal('subscribe'), channels, id }).strict(),
  z.object({ op: z.literal('unsubscribe'), channels, id }).strict(),
  z.object({ op: z.literal('ping'), id }).strict(),
]);
type Op = z.infer<typeof OpSchema>;

class Connection implements HubClient {
  principal: Principal | null = null;
  readonly channels = new Set<string>();
  alive = true;
  chain: Promise<void> = Promise.resolve();
  ops: number[] = [];
  timers: NodeJS.Timeout[] = [];
  corked = false;
  readonly socket: Socket;

  constructor(
    readonly id: number,
    readonly ws: WebSocket,
    private readonly flusher: Flusher,
  ) {
    // ws keeps the upgraded TCP socket here; with per-message deflate off its own sends are
    // synchronous writes to the same socket, so frame order is preserved.
    this.socket = (ws as unknown as { _socket: Socket })._socket;
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  /** Pre-built frame; frames within the flush window are corked into a single writev. */
  send(frame: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.corked) {
      this.corked = true;
      this.socket.cork();
      this.flusher.mark(this);
    }
    this.socket.write(frame);
  }

  uncork(): void {
    if (!this.corked) return;
    this.corked = false;
    this.socket.uncork();
  }

  json(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    this.uncork(); // control replies are never delayed
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }
}

/**
 * Write coalescing. Profiling showed fan-out is bound by one write syscall per frame per client
 * (loopback TCP does receive-side work inside the sender's syscall), so corked sockets are flushed
 * together once per window: one writev per client per window instead of one write per frame.
 */
class Flusher {
  private readonly dirty = new Set<Connection>();
  private scheduled = false;

  constructor(private readonly windowMs: number) {}

  mark(c: Connection): void {
    this.dirty.add(c);
    if (this.scheduled) return;
    this.scheduled = true;
    if (this.windowMs > 0) setTimeout(() => this.flush(), this.windowMs);
    else setImmediate(() => this.flush());
  }

  flush(): void {
    this.scheduled = false;
    for (const c of this.dirty) c.uncork();
    this.dirty.clear();
  }
}

/**
 * Market data WebSocket gateway (goal 02), attached to the Nest HTTP server at /ws.
 * Auth: the `kora_at` cookie (browsers; Origin must be allowed) or a first `{op:"auth"}` message.
 * Channels: quotes:{symbol}, depth:{symbol}, candles:{symbol}:{tf}, status.
 */
@Injectable()
export class MarketDataGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('MarketDataGateway');
  private wss: WebSocketServer | null = null;
  private server: Server | null = null;
  private readonly conns = new Set<Connection>();
  private nextId = 1;
  private pingTimer: NodeJS.Timeout | null = null;
  private flusher: Flusher;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly hub: ChannelHub,
    private readonly tokens: TokenService,
    private readonly repo: InstrumentsRepository,
    @Inject(MD_CONFIG) private readonly cfg: MdConfig,
  ) {
    this.flusher = new Flusher(cfg.wsFlushMs);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.hub.init();
    await this.repo.load();
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
    this.server.on('upgrade', this.onUpgrade);
    this.pingTimer = setInterval(() => this.heartbeat(), PING_MS);
    this.pingTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.server?.off('upgrade', this.onUpgrade);
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !this.cfg.wsOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const cookieToken = parseCookie(req.headers.cookie, ACCESS_COOKIE);
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, cookieToken));
  };

  private onConnection(ws: WebSocket, cookieToken: string | null): void {
    const conn = new Connection(this.nextId++, ws, this.flusher);
    this.conns.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('close', () => this.cleanup(conn));
    ws.on('error', () => this.cleanup(conn));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      conn.chain = conn.chain.then(() => this.onMessage(conn, data, isBinary)).catch((e: Error) => this.log.warn(`ws ${conn.id}: ${e.message}`));
    });
    conn.json({ type: 'welcome', protocol: 1, simulated: true, conflation: { maxPerSecond: this.cfg.conflatePerSec, burst: this.cfg.conflateBurst } });
    if (cookieToken) conn.chain = conn.chain.then(() => this.authenticate(conn, cookieToken));
    else {
      const t = setTimeout(() => {
        if (!conn.principal) conn.close(4401, 'authentication timeout');
      }, AUTH_TIMEOUT_MS);
      t.unref();
      conn.timers.push(t);
    }
  }

  private async onMessage(conn: Connection, data: RawData, isBinary: boolean): Promise<void> {
    const now = Date.now();
    conn.ops = conn.ops.filter((t) => now - t < OPS_WINDOW_MS);
    conn.ops.push(now);
    if (conn.ops.length > OPS_PER_WINDOW) {
      conn.close(1008, 'rate limit');
      return;
    }
    let op: Op;
    try {
      if (isBinary) throw new Error('binary');
      const parsed = OpSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) throw new Error('schema');
      op = parsed.data;
    } catch {
      conn.json({ type: 'error', code: 'bad_request', message: 'Expected a JSON op: auth | subscribe | unsubscribe | ping' });
      return;
    }
    if (op.op === 'auth') return this.authenticate(conn, op.token);
    if (!conn.principal) {
      conn.json({ type: 'error', code: 'unauthenticated', message: 'Send {op:"auth", token} first' });
      return;
    }
    if (op.op === 'ping') return conn.json({ type: 'pong', id: op.id, ts: now });
    if (op.op === 'unsubscribe') {
      for (const ch of op.channels) if (conn.channels.delete(ch)) this.hub.unsubscribe(conn, ch);
      return conn.json({ type: 'unsubscribed', channels: op.channels, id: op.id });
    }
    const registry = await this.repo.load();
    const accepted: string[] = [];
    const rejected: Array<{ channel: string; code: string }> = [];
    for (const ch of op.channels) {
      const p = parseChannel(ch);
      if (!p) rejected.push({ channel: ch, code: 'invalid_channel' });
      else if (p.symbol && !registry.instruments.has(p.symbol)) rejected.push({ channel: ch, code: 'unknown_symbol' });
      else if (!conn.channels.has(ch) && !accepted.includes(ch) && conn.channels.size + accepted.length >= this.cfg.wsMaxChannels) rejected.push({ channel: ch, code: 'too_many_channels' });
      else if (!conn.channels.has(ch) && !accepted.includes(ch)) accepted.push(ch);
    }
    for (const ch of accepted) conn.channels.add(ch);
    conn.json({ type: 'subscribed', channels: accepted, rejected, id: op.id });
    for (const ch of accepted) {
      if (!this.conns.has(conn) || !conn.channels.has(ch)) continue;
      await this.hub.subscribe(conn, ch);
      // The client may have closed or unsubscribed while we awaited Redis: never leak a subscriber.
      if (!this.conns.has(conn) || !conn.channels.has(ch)) this.hub.unsubscribe(conn, ch);
    }
  }

  private async authenticate(conn: Connection, token: string): Promise<void> {
    try {
      const p = await this.tokens.verifyAccessToken(token);
      if (requiresMfa(p.roles) && !p.mfa) {
        conn.close(4403, 'mfa required');
        return;
      }
      conn.principal = p;
      const exp = decodeJwt(token).exp;
      if (exp) {
        const t = setTimeout(() => conn.close(4401, 'token expired'), Math.max(0, exp * 1000 - Date.now()));
        t.unref();
        conn.timers.push(t);
      }
      conn.json({ type: 'authenticated', sub: p.sub });
    } catch {
      conn.close(4401, 'invalid token');
    }
  }

  private cleanup(conn: Connection): void {
    if (!this.conns.delete(conn)) return;
    conn.uncork();
    for (const t of conn.timers) clearTimeout(t);
    for (const ch of conn.channels) this.hub.unsubscribe(conn, ch);
    conn.channels.clear();
  }

  private heartbeat(): void {
    for (const c of this.conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }
}

export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
