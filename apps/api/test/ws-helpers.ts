import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';

export async function listen(app: INestApplication): Promise<{ http: string; ws: string }> {
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Msg = any;

/** Minimal test client that records every frame with its receive time. */
export class TestWs {
  readonly messages: Array<{ at: number; msg: Msg }> = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      this.messages.push({ at: Date.now(), msg: JSON.parse(d.toString()) });
      this.wake();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.wake();
    });
  }

  static open(url: string, headers: Record<string, string> = {}): Promise<TestWs> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const t = new TestWs(ws);
      ws.once('open', () => resolve(t));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  static async authed(url: string, token: string, channels: string[] = []): Promise<TestWs> {
    const t = await TestWs.open(url);
    t.send({ op: 'auth', token });
    await t.waitFor((m) => m.type === 'authenticated');
    if (channels.length) {
      t.send({ op: 'subscribe', channels, id: 'sub' });
      await t.waitFor((m) => m.type === 'subscribed' && m.id === 'sub');
    }
    return t;
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** Resolves with the first message (from index `from`) matching pred. */
  async waitFor(
    pred: (m: Msg) => boolean,
    timeoutMs = 5000,
    from = 0,
  ): Promise<{ at: number; msg: Msg; index: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.messages.findIndex((x, idx) => idx >= from && pred(x.msg));
      if (i >= 0) return { ...this.messages[i]!, index: i };
      if (this.closed) throw new Error(`socket closed ${this.closed.code} ${this.closed.reason}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timeout waiting for message');
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async waitClose(timeoutMs = 7000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('timeout waiting for close');
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.closed;
  }

  close(): void {
    this.ws.close();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
}
