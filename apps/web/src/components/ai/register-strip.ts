'use client';

import { registerAiStrip } from '@/lib/terminal/ai-strip';

import { CopilotStrip } from './CopilotStrip';

// Goal 07 fills the goal 04 AI strip slot (shown when KORA_AI_STRIP=on).
registerAiStrip(CopilotStrip);
