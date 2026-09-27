import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  AUDIT_READ_ALL_ROLES,
  hasAnyRole,
  isPrivateChannelKind,
  parseChannel,
  requiresMfa,
} from '@kora/domain';
import { Redis } from 'ioredis';
import { decodeJwt } from 'jose';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';

import { ACCESS_COOKIE } from '../auth/cookies';
import type { Principal } from '../auth/principal';
import { SessionsService, type SessionRevocation } from '../auth/sessions.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { TokenService } from '../auth/token.service';
import { DbService } from '../db/db.service';
import { ChannelHub, type HubClient } from './channel-hub';
import { InstrumentsRepository } from './instruments.repository';
import { busChannel, MD_CONFIG, type MdConfig } from './md-config';

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
  /** Account ownership checks already answered for this connection. */
  readonly accounts = new Map<string, boolean>();
  alive = true;
  chain: Promise<void> = Promise.resolve();
  ops: number[] = [];
  timers: NodeJS.Timeout[] = [];
  corked = false;
  /** B-203: the timer that closes the socket when the current token expires (re-armed on refresh). */
  expiry: NodeJS.Timeout | null = null;
  readonly socket: Socket;

  constructor(
    readonly id: number,
    readonly ws: WebSocket,
    private readonly flusher: Flusher,
    readonly ip: string,
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
 * Channels: quotes:{symbol}, depth:{symbol}, candles:{symbol}:{tf}, status; and the private
 * trading channels orders:{account}, positions:{account}, account:{account} (goal 03).
 */
@Injectable()
export class MarketDataGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('MarketDataGateway');
  private wss: WebSocketServer | null = null;
  private server: Server | null = null;
  private readonly conns = new Set<Connection>();
  private nextId = 1;
  private pingTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private flusher: Flusher;
  /** IRTC R1-03: cross-replica session revocations (Redis pub/sub). */
  private revocationSub: Redis | null = null;
  private revocationPub: Redis | null = null;
  private readonly origin = randomUUID();
  private readonly onLocalRevocation = (r: SessionRevocation): void => {
    this.applyRevocation(r);
    this.revocationPub
      ?.publish(this.revocationChannel, JSON.stringify({ ...r, origin: this.origin }))
      .catch(() => undefined);
  };

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly hub: ChannelHub,
    private readonly tokens: TokenService,
    private readonly repo: InstrumentsRepository,
    @Inject(MD_CONFIG) private readonly cfg: MdConfig,
    private readonly db: DbService,
    @Optional() private readonly sessions?: SessionsService,
    @Optional() @Inject(APP_CONFIG) private readonly app?: AppConfig,
  ) {
    this.flusher = new Flusher(cfg.wsFlushMs);
  }

  private get revocationChannel(): string {
    return busChannel(this.cfg, 'sessions:revoked');
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.hub.init();
    await this.repo
      .load()
      .catch((e: Error) =>
        this.log.warn(`registry not loaded yet (${e.message}); will load on first subscribe`),
      );
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 16 * 1024,
      perMessageDeflate: false,
    });
    this.server.on('upgrade', this.onUpgrade);
    this.pingTimer = setInterval(() => this.heartbeat(), PING_MS);
    this.pingTimer.unref();
    // IRTC R1-03: sessions revoked while a socket is open end that socket.
    if (this.sessions) {
      this.sessions.events.on('revoked', this.onLocalRevocation);
      this.sweepTimer = setInterval(() => void this.sweepSessions(), this.cfg.wsSessionSweepMs);
      this.sweepTimer.unref();
      if (this.app) {
        this.revocationPub = new Redis(this.app.redisUrl, { maxRetriesPerRequest: 2 });
        this.revocationSub = new Redis(this.app.redisUrl, { maxRetriesPerRequest: null });
        for (const r of [this.revocationPub, this.revocationSub])
          r.on('error', (e: Error) => this.log.warn(`redis (session revocations): ${e.message}`));
        this.revocationSub.on('message', (_ch: string, payload: string) =>
          this.onRemoteRevocation(payload),
        );
        await this.revocationSub
          .subscribe(this.revocationChannel)
          .catch((e: Error) => this.log.warn(`session revocation channel: ${e.message}`));
      }
    }
  }

  private onRemoteRevocation(payload: string): void {
    try {
      const m = JSON.parse(payload) as SessionRevocation & { origin?: string };
      if (m.origin === this.origin || typeof m.userId !== 'string') return;
      this.sessions?.forget(m.userId);
      this.applyRevocation({
        userId: m.userId,
        tokenId: typeof m.tokenId === 'string' ? m.tokenId : undefined,
        validAfterSec: typeof m.validAfterSec === 'number' ? m.validAfterSec : undefined,
      });
    } catch {
      // ignore malformed bus messages
    }
  }

  /** Closes the user's sockets that the revocation covers; anything unclear is re-checked in the DB. */
  private applyRevocation(r: SessionRevocation): void {
    for (const c of this.conns) {
      const p = c.principal;
      if (!p || p.sub !== r.userId) continue;
      if (r.tokenId && p.tokenId === r.tokenId) c.close(4401, 'session revoked');
      else if (
        r.validAfterSec !== undefined &&
        p.issuedAt !== undefined &&
        p.issuedAt < r.validAfterSec
      )
        c.close(4401, 'session revoked');
      else if (!r.tokenId && r.validAfterSec === undefined) void this.recheck(c);
    }
  }

  private async recheck(c: Connection): Promise<void> {
    if (!c.principal || !this.sessions) return;
    if (!(await this.sessions.isActive(c.principal, { fresh: true }).catch(() => true)))
      c.close(4401, 'session revoked');
  }

  /** IRTC R1-03: periodic re-check of every authenticated socket (catches out-of-band changes). */
  private async sweepSessions(): Promise<void> {
    if (!this.sessions || this.sweeping) return;
    this.sweeping = true;
    try {
      const open = [...this.conns].filter((c) => c.principal);
      const dead = await this.sessions.inactive(
        open.map((c) => Object.assign({}, c.principal!, { conn: c })),
      );
      for (const d of dead) d.conn.close(4401, 'session revoked');
    } catch (e) {
      this.log.warn(`session sweep failed: ${(e as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sessions?.events.off('revoked', this.onLocalRevocation);
    this.revocationSub?.disconnect();
    this.revocationPub?.disconnect();
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
    // B-203: per-IP quota (the socket address; X-Forwarded-For is not trusted here, B-015).
    const ip = req.socket.remoteAddress ?? 'unknown';
    let fromIp = 0;
    for (const c of this.conns) if (c.ip === ip) fromIp += 1;
    if (fromIp >= this.cfg.wsMaxConnPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const cookieToken = parseCookie(req.headers.cookie, ACCESS_COOKIE);
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, cookieToken, ip));
  };

  private onConnection(ws: WebSocket, cookieToken: string | null, ip: string): void {
    const conn = new Connection(this.nextId++, ws, this.flusher, ip);
    this.conns.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('close', () => this.cleanup(conn));
    ws.on('error', () => this.cleanup(conn));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      conn.chain = conn.chain
        .then(() => this.onMessage(conn, data, isBinary))
        .catch((e: Error) => this.log.warn(`ws ${conn.id}: ${e.message}`));
    });
    conn.json({
      type: 'welcome',
      protocol: 1,
      simulated: true,
      conflation: { maxPerSecond: this.cfg.conflatePerSec, burst: this.cfg.conflateBurst },
    });
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
      conn.json({
        type: 'error',
        code: 'bad_request',
        message: 'Expected a JSON op: auth | subscribe | unsubscribe | ping',
      });
      return;
    }
    if (op.op === 'auth') return this.authenticate(conn, op.token);
    if (!conn.principal) {
      conn.json({
        type: 'error',
        code: 'unauthenticated',
        message: 'Send {op:"auth", token} first',
      });
      return;
    }
    if (op.op === 'ping') return conn.json({ type: 'pong', id: op.id, ts: now });
    // IRTC R1-03: never grant a subscription on cached roles; the session must still be live.
    if (
      op.op === 'subscribe' &&
      this.sessions &&
      !(await this.sessions.isActive(conn.principal, { fresh: true }))
    ) {
      conn.close(4401, 'session revoked');
      return;
    }
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
      else if (isPrivateChannelKind(p.kind) && !(await this.canReadAccount(conn, p.accountId!)))
        rejected.push({ channel: ch, code: 'forbidden' });
      else if (p.kind === 'risk' && !hasAnyRole(conn.principal!.roles, AUDIT_READ_ALL_ROLES))
        rejected.push({ channel: ch, code: 'forbidden' });
      else if (p.symbol && !registry.instruments.has(p.symbol))
        rejected.push({ channel: ch, code: 'unknown_symbol' });
      else if (
        !conn.channels.has(ch) &&
        !accepted.includes(ch) &&
        conn.channels.size + accepted.length >= this.cfg.wsMaxChannels
      )
        rejected.push({ channel: ch, code: 'too_many_channels' });
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

  /** Private trading channels (goal 03): the account owner, or a risk officer / admin. */
  private async canReadAccount(conn: Connection, accountId: string): Promise<boolean> {
    const p = conn.principal!;
    if (hasAnyRole(p.roles, AUDIT_READ_ALL_ROLES)) return true;
    const cached = conn.accounts.get(accountId);
    if (cached !== undefined) return cached;
    const rows = await this.db.query<{ ok: boolean }>(
      'SELECT true AS ok FROM accounts WHERE id = $1 AND user_id = $2',
      [accountId, p.sub],
    );
    const ok = rows.length > 0;
    conn.accounts.set(accountId, ok);
    return ok;
  }

  /**
   * First `auth` authenticates the socket; a later `auth` (B-203) refreshes the token on the open
   * socket: same subject only, the expiry timer is re-armed, subscriptions stay.
   */
  private async authenticate(conn: Connection, token: string): Promise<void> {
    const refresh = conn.principal !== null;
    try {
      const p = await this.tokens.verifyAccessToken(token);
      // Goal 10 (S9 finding): a logged-out, role-changed or disabled session must not open a socket.
      if (this.sessions && !(await this.sessions.isActive(p))) {
        conn.close(4401, 'session revoked');
        return;
      }
      if (requiresMfa(p.roles) && !p.mfa) {
        conn.close(4403, 'mfa required');
        return;
      }
      if (refresh && p.sub !== conn.principal!.sub) {
        conn.close(4403, 'subject mismatch');
        return;
      }
      if (!refresh) {
        // B-203: per-user quota.
        let mine = 0;
        for (const c of this.conns) if (c !== conn && c.principal?.sub === p.sub) mine += 1;
        if (mine >= this.cfg.wsMaxConnPerUser) {
          conn.close(4429, 'too many connections');
          return;
        }
      }
      conn.principal = p;
      if (refresh) conn.accounts.clear();
      if (conn.expiry) clearTimeout(conn.expiry);
      conn.expiry = null;
      const exp = decodeJwt(token).exp;
      if (exp) {
        conn.expiry = setTimeout(
          () => conn.close(4401, 'token expired'),
          Math.max(0, exp * 1000 - Date.now()),
        );
        conn.expiry.unref();
      }
      conn.json({
        type: 'authenticated',
        sub: p.sub,
        ...(refresh ? { refreshed: true } : {}),
        exp: exp ?? null,
      });
    } catch {
      conn.close(4401, 'invalid token');
    }
  }

  private cleanup(conn: Connection): void {
    if (!this.conns.delete(conn)) return;
    conn.uncork();
    for (const t of conn.timers) clearTimeout(t);
    if (conn.expiry) clearTimeout(conn.expiry);
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
