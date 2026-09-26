import type { InstrumentSpec } from '@kora/domain';

import { AdapterNotConfiguredError } from '../adapter.js';
import { UnconfiguredLiveTransport, type StubAdapterBase, type StubTransport } from './base.js';
import { CryptoTestnetStubAdapter } from './crypto-testnet.js';
import { EquitiesProviderStubAdapter } from './equities-provider.js';
import { FxCfdBrokerStubAdapter } from './fxcfd-broker.js';

export const STUB_SOURCES = ['broker-fxcfd', 'crypto-testnet', 'equities-provider'] as const;
export type StubSource = (typeof STUB_SOURCES)[number];

/** Feature flags: every stub is off unless its flag is exactly "true". */
export const STUB_FLAGS: Record<StubSource, string> = {
  'broker-fxcfd': 'KORA_MD_ADAPTER_FXCFD',
  'crypto-testnet': 'KORA_MD_ADAPTER_CRYPTO_TESTNET',
  'equities-provider': 'KORA_MD_ADAPTER_EQUITIES',
};

export function isStubEnabled(source: StubSource, env: Record<string, string | undefined>): boolean {
  return env[STUB_FLAGS[source]] === 'true';
}

export function createStubAdapter(
  source: StubSource,
  opts: {
    env: Record<string, string | undefined>;
    instruments: InstrumentSpec[];
    symbolMap: Record<string, string>;
    transport?: StubTransport;
    clock?: () => number;
  },
): StubAdapterBase {
  if (!isStubEnabled(source, opts.env)) {
    throw new AdapterNotConfiguredError(source, `disabled by feature flag (set ${STUB_FLAGS[source]}=true to enable the stub)`);
  }
  const base = {
    instruments: opts.instruments,
    symbolMap: opts.symbolMap,
    transport: opts.transport ?? new UnconfiguredLiveTransport(source),
    clock: opts.clock,
  };
  switch (source) {
    case 'broker-fxcfd':
      return new FxCfdBrokerStubAdapter(base);
    case 'crypto-testnet':
      return new CryptoTestnetStubAdapter(base);
    case 'equities-provider':
      return new EquitiesProviderStubAdapter(base);
  }
}
