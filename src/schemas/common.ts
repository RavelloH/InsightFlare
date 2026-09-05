import { z } from "zod";

// ─── Schema Registry ────────────────────────────────────────────────────

interface SchemaDefinition {
  name: string;
  schema: z.ZodTypeAny;
}

const schemaRegistry = new Map<string, z.ZodTypeAny>();

export function registerSchema(name: string, schema: z.ZodTypeAny) {
  schemaRegistry.set(name, schema);
}

export function getAllRegisteredSchemas(): SchemaDefinition[] {
  return Array.from(schemaRegistry.entries()).map(([name, schema]) => ({
    name,
    schema,
  }));
}

// ─── Base Schemas ───────────────────────────────────────────────────────

export const EnvelopeSchema = z
  .object({
    ok: z.literal(true),
    requestId: z.string().describe("Cloudflare Ray ID for request tracing"),
    timestamp: z.string().describe("ISO 8601 response generation time"),
  })
  .describe("Standard success response envelope");

export const ErrorDetailSchema = z.object({
  code: z
    .string()
    .describe(
      "Machine-readable error code (e.g. INVALID_API_KEY, INSUFFICIENT_PERMISSIONS, SITE_NOT_FOUND, INVALID_REQUEST_BODY, RATE_LIMIT_EXCEEDED, QUERY_INVALID, INTERNAL_ERROR)",
    ),
  message: z.string().describe("Human-readable error description"),
});

export const ErrorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    requestId: z.string(),
    timestamp: z.string(),
    error: ErrorDetailSchema,
  })
  .describe("Standard error response envelope");

export const PaginationMetaSchema = z
  .object({
    limit: z.number().int().positive().describe("Maximum results requested"),
    returned: z.number().int().describe("Number of results in this page"),
    hasMore: z.boolean().describe("Whether more pages exist"),
    nextCursor: z
      .string()
      .nullable()
      .describe("Opaque cursor for the next page"),
  })
  .describe("Pagination metadata for list endpoints");

// ─── Envelope Builders ──────────────────────────────────────────────────

export function createEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return EnvelopeSchema.extend({
    data: dataSchema,
  });
}

export function createPaginatedEnvelopeSchema<T extends z.ZodTypeAny>(
  dataSchema: T,
) {
  return EnvelopeSchema.extend({
    data: z.object({
      items: z.array(dataSchema),
      pagination: PaginationMetaSchema,
    }),
  });
}

// ─── Register ───────────────────────────────────────────────────────────

registerSchema("Envelope", EnvelopeSchema);
registerSchema("ErrorEnvelope", ErrorEnvelopeSchema);
registerSchema("PaginationMeta", PaginationMetaSchema);
