/* global __ENV, __VU */
// k6 reference scenario for the goal 02 fan-out criterion (for CI/Docker hosts where k6 is
// installed; NOT executed in the build environment, whose proxy blocks the k6 binary download).
// The executed tool is ws-fanout.mjs, which also provides the api + Redis publisher:
//   node load/ws-fanout.mjs --clients 0 --duration 60      # api (feed off) + 200 × 10 Hz publisher
//   k6 run -e WS_URL=ws://127.0.0.1:4020/ws -e TOKEN=<bearer> load/ws-fanout.k6.js
// Latency = receive time − pubTs stamped by the publisher (same host clock).
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import ws from 'k6/ws';

const fanout = new Trend('fanout_latency_ms', true);
const frames = new Counter('frames');
const SYMBOLS = Number(__ENV.SYMBOLS || 200);
const PER_CLIENT = Number(__ENV.PER_CLIENT || 20);

export const options = {
  scenarios: {
    clients: {
      executor: 'constant-vus',
      vus: Number(__ENV.CLIENTS || 500),
      duration: __ENV.DURATION || '40s',
    },
  },
  thresholds: { fanout_latency_ms: ['p(99)<50'] },
};

export default function () {
  const channels = [];
  let s = __VU * 2654435761;
  while (channels.length < PER_CLIENT) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    const ch = `quotes:LOADTEST${String((s % SYMBOLS) + 1).padStart(3, '0')}`;
    if (!channels.includes(ch)) channels.push(ch);
  }
  const res = ws.connect(__ENV.WS_URL, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ op: 'auth', token: __ENV.TOKEN }));
      socket.send(JSON.stringify({ op: 'subscribe', channels }));
    });
    socket.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (!m.ch || m.snapshot || !m.data.pubTs) return;
      frames.add(1);
      fanout.add(Date.now() - m.data.pubTs);
    });
    socket.setTimeout(() => socket.close(), 35_000);
  });
  check(res, { 'upgraded (101)': (r) => r && r.status === 101 });
}
