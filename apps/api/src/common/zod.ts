import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z, type ZodType } from 'zod';

/** Validates a request part with a zod schema; unknown keys fail when the schema is strict. */
export class ZodValidationPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'validation_failed',
        message: 'Request validation failed',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      });
    }
    return result.data;
  }
}

/** JSON Schema for OpenAPI docs, derived from the same zod schema used at runtime. */
export function openApiSchema(
  schema: ZodType,
  io: 'input' | 'output' = 'input',
): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
