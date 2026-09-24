import { z } from "zod";

export const TypedBatchItemSchema = z
  .object({
    id: z.string().min(1).max(80),
    method: z.enum(["GET", "POST"]),
    path: z.string().min(1).max(2048),
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const TypedBatchRequestSchema = z
  .object({
    requests: z.array(TypedBatchItemSchema).min(1).max(50),
    deadlineMs: z.number().int().min(1).max(30_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.requests.forEach((item, index) => {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          message: "Batch item IDs must be unique",
          path: ["requests", index, "id"],
        });
      }
      ids.add(item.id);
    });
  });

export type TypedBatchRequest = z.infer<typeof TypedBatchRequestSchema>;
export type TypedBatchItem = TypedBatchRequest["requests"][number];
