import { AiDraftLoader } from '@/components/intel/AiDraftLoader';
import { TerminalLoader } from '@/components/terminal/TerminalLoader';
import { parseAiStripMode } from '@/lib/terminal/ai-strip';
import { apiWsPort } from '@/lib/market-ws';
import { DEFAULT_SYMBOL } from '@/lib/modes';

export const metadata = { title: 'Terminal' };

export default async function TerminalPage({
  searchParams,
}: {
  searchParams: Promise<{ symbol?: string; aiDraft?: string }>;
}) {
  const params = await searchParams;
  const symbol =
    (params.symbol ?? DEFAULT_SYMBOL)
      .toUpperCase()
      .replace(/[^A-Z0-9._-]/g, '')
      .slice(0, 32) || DEFAULT_SYMBOL;
  return (
    <div className="h-full min-h-[560px]" data-testid="terminal">
      <h1 className="k-sr-only">Pro terminal</h1>
      <AiDraftLoader draftId={params.aiDraft ?? null} />
      <TerminalLoader
        initialSymbol={symbol}
        wsPort={apiWsPort()}
        aiStrip={parseAiStripMode(process.env.KORA_AI_STRIP)}
      />
    </div>
  );
}
