import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { parseChannel, STATUS_CHANNEL, type FeedStatus } from '@kora/domain';
import { Conflator } from '@kora/market-data';
import { Redis } from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../config/config';
import { busChannel, lastKey, MD_CONFIG, type MdConfig } from './md-config';

export interface HubClient {
  readonly id: number;
  readonly bufferedAmount: number;
  /** Writes a complete, pre-built WebSocket frame (see `wsTextFrame`). */
  send(frame: Buffer): void;
  close(code: number, reason: string): void;
}

const HIGH_WATER = 1024 * 1024; // skip frames for a client above 1 MiB buffered
const MAX_BUFFER = 8 * 1024 * 1024; // disconnect above 8 MiB

export interface HubStats {
  channels: number;
  subscriptions: number;
  messagesIn: number;
  framesOut: number;
  dropped: number;
  slowClosed: number;
  conflated: number;
  feedLost: boolean;
}

/**
 * Gateway-side fan-out. One Redis SUBSCRIBE per channel with at least one client
 * (reference-counted), per-channel conflation (≤ N/s), frames serialised once per message.
 * Watches the feed heartbeat on `status`: if it stops, synthesises a `down` status and stale quotes
 * so clients still learn the feed is gone when the whole feed process dies.
 */
@Injectable()
export class ChannelHub implements OnModuleDestroy {
  private readonly log = new Logger('ChannelHub');
  private sub: Redis | null = null;
  private cmd: Redis | null = null;
  private readonly subscribers = new Map<string, Set<HubClient>>();
  private readonly last = new Map<string, string>();
  private readonly conflator: Conflator<string>;
  private lastStatusAt = Date.now();
  private feedLost = false;
  private monitor: NodeJS.Timeout | null = null;
  private readonly counters = { messagesIn: 0, framesOut: 0, dropped: 0, slowClosed: 0 };

  constructor(
    @Inject(APP_CONFIG) private readonly app: AppConfig,
    @Inject(MD_CONFIG) private readonly cfg: MdConfig,
  ) {
    this.conflator = new Conflator<string>((ch, payload) => this.fanOut(ch, payload), cfg.conflatePerSec, cfg.conflateBurst);
  }

  async init(): Promise<void> {
    if (this.sub) return;
    this.sub = new Redis(this.app.redisUrl, { maxRetriesPerRequest: null });
    this.cmd = new Redis(this.app.redisUrl, { maxRetriesPerRequest: 2 });
    for (const r of [this.sub, this.cmd]) r.on('error', (e) => this.log.warn(`redis: ${e.message}`));
    this.sub.on('message', (ch: string, payload: string) => this.onBusMessage(ch, payload));
    await this.sub.subscribe(busChannel(this.cfg, STATUS_CHANNEL));
    this.lastStatusAt = Date.now();
    this.monitor = setInterval(() => this.checkHeartbeat(), 250);
    this.monitor.unref();
  }

  async subscribe(client: HubClient, channel: string): Promise<void> {
    let set = this.subscribers.get(channel);
    if (!set) {
      set = new Set();
      this.subscribers.set(channel, set);
      if (channel !== STATUS_CHANNEL) await this.sub!.subscribe(busChannel(this.cfg, channel));
    }
    set.add(client);
    let payload = this.last.get(channel) ?? (await this.cmd!.get(lastKey(this.cfg, channel)));
    if (payload) {
      if (this.feedLost && channel.startsWith('quotes:')) payload = markStale(payload);
      this.sendTo(client, frame(channel, payload, true));
    }
  }

  unsubscribe(client: HubClient, channel: string): void {
    const set = this.subscribers.get(channel);
    if (!set?.delete(client) || set.size > 0) return;
    this.subscribers.delete(channel);
    this.conflator.drop(channel);
    if (channel !== STATUS_CHANNEL) {
      this.last.delete(channel);
      void this.sub?.unsubscribe(busChannel(this.cfg, channel)).catch(() => undefined);
    }
  }

  /** Last-value cache (Redis) for REST reads. */
  async getLast(channels: string[]): Promise<Array<string | null>> {
    await this.init();
    return channels.length ? this.cmd!.mget(...channels.map((c) => lastKey(this.cfg, c))) : [];
  }

  isSubscribed(channel: string): boolean {
    return this.subscribers.has(channel);
  }

  stats(): HubStats {
    let subscriptions = 0;
    for (const s of this.subscribers.values()) subscriptions += s.size;
    return { channels: this.subscribers.size, subscriptions, ...this.counters, conflated: this.conflator.conflated, feedLost: this.feedLost };
  }

  lastStatus(): FeedStatus | null {
    const s = this.last.get(STATUS_CHANNEL);
    return s ? (JSON.parse(s) as FeedStatus) : null;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.monitor) clearInterval(this.monitor);
    this.conflator.close();
    this.sub?.disconnect();
    this.cmd?.disconnect();
  }

  private onBusMessage(bus: string, payload: string): void {
    const ch = bus.slice(this.cfg.prefix.length);
    this.counters.messagesIn += 1;
    if (ch === STATUS_CHANNEL) {
      this.lastStatusAt = Date.now();
      if (this.feedLost) {
        this.feedLost = false;
        this.log.log('feed heartbeat restored');
      }
    }
    if (ch !== STATUS_CHANNEL && !this.subscribers.has(ch)) return;
    this.last.set(ch, payload);
    if (this.subscribers.has(ch)) this.conflator.offer(ch, payload);
  }

  private checkHeartbeat(): void {
    const now = Date.now();
    if (this.feedLost || now - this.lastStatusAt <= this.cfg.feedTimeoutMs) return;
    this.feedLost = true;
    this.log.warn(`no feed heartbeat for ${now - this.lastStatusAt} ms: marking feed down`);
    const quotes = [...this.subscribers.keys()].filter((c) => c.startsWith('quotes:'));
    const status: FeedStatus = {
      type: 'status',
      state: 'down',
      ts: now,
      feeds: this.lastStatus()?.feeds.map((f) => ({ ...f, state: f.state === 'disabled' ? 'disabled' : 'down' })) ?? [],
      staleSymbols: quotes.map((c) => parseChannel(c)!.symbol!).sort(),
      reason: 'feed_heartbeat_lost',
    };
    const json = JSON.stringify(status);
    this.last.set(STATUS_CHANNEL, json);
    this.conflator.offer(STATUS_CHANNEL, json);
    for (const ch of quotes) {
      const p = this.last.get(ch);
      if (p) this.conflator.offer(ch, markStale(p));
    }
  }

  private fanOut(channel: string, payload: string): void {
    const set = this.subscribers.get(channel);
    if (!set || set.size === 0) return;
    const buf = frame(channel, payload, false);
    for (const c of set) this.sendTo(c, buf);
  }

  private sendTo(c: HubClient, buf: Buffer): void {
    const buffered = c.bufferedAmount;
    if (buffered > MAX_BUFFER) {
      this.counters.slowClosed += 1;
      c.close(1013, 'slow consumer');
    } else if (buffered > HIGH_WATER) {
      this.counters.dropped += 1;
    } else {
      this.counters.framesOut += 1;
      c.send(buf);
    }
  }
}

/** Channel names are validated (no quotes), payloads are JSON produced by the feed. */
export function frame(channel: string, payload: string, snapshot: boolean): Buffer {
  return wsTextFrame(Buffer.from(`{"ch":"${channel}"${snapshot ? ',"snapshot":true' : ''},"data":${payload}}`));
}

/**
 * RFC 6455 server→client text frame (FIN, unmasked, no extensions). Built once per message and
 * written as-is to every subscriber, so fan-out cost is a buffer reference per client.
 */
export function wsTextFrame(payload: Buffer): Buffer {
  const n = payload.length;
  let header: Buffer;
  if (n < 126) {
    header = Buffer.from([0x81, n]);
  } else if (n < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}

function markStale(payload: string): string {
  const q = JSON.parse(payload) as { stale?: boolean };
  return JSON.stringify({ ...q, stale: true });
}
