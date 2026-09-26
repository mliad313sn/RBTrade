import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openApiSchema, ZodValidationPipe } from './zod';

describe('ZodValidationPipe', () => {
  const schema = z.object({ email: z.string().email(), n: z.number().int() }).strict();
  it('returns parsed data', () => {
    expect(new ZodValidationPipe(schema).transform({ email: 'a@b.co', n: 1 })).toEqual({ email: 'a@b.co', n: 1 });
  });
  it('throws a 400 with issues', () => {
    try {
      new ZodValidationPipe(schema).transform({ email: 'x', n: 1.5, extra: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const body = (e as BadRequestException).getResponse() as { issues: unknown[] };
      expect(body.issues.length).toBeGreaterThanOrEqual(2);
    }
  });
  it('emits JSON schema without $schema', () => {
    const s = openApiSchema(schema);
    expect(s.$schema).toBeUndefined();
    expect(s.type).toBe('object');
  });
});
