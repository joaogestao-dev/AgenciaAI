import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    lead_id: z.string().uuid(),
    client_type: z.string().min(1).max(50).optional().default("fixo"),
    assigned_products: z.array(z.string().uuid()).max(20).optional().default([]),
  })
  .strict();

export const convertLeadToClient: ActionDef = {
  description:
    "Converte um lead (deve estar em status 'fechamento') em agency_client. Atomico via RPC paperclip_convert_lead. Idempotente em 24h por nome+workspace.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["lead_id"],
    properties: {
      lead_id: { type: "string", format: "uuid" },
      client_type: { type: "string", minLength: 1, maxLength: 50, default: "fixo" },
      assigned_products: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 20, default: [] },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    const { data, error } = await supabase.rpc("paperclip_convert_lead", {
      p_lead_id: params.lead_id,
      p_client_type: params.client_type,
      p_assigned_products: params.assigned_products,
    });
    if (error) {
      const code = error.code === "23514" ? "lead_status_invalid" : error.code === "02000" ? "lead_not_found" : "db_error";
      const e = new Error(error.message ?? "Falha na conversao") as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = code;
      e.httpStatus = 422;
      throw e;
    }
    return data;
  },
};
