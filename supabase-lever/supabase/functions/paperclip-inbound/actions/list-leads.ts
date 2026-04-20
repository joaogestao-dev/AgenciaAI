import { z } from "zod";
import type { ActionDef } from "../registry.ts";
import { redactEmail, redactPhone } from "../_shared/redact.ts";

const paramsSchema = z
  .object({
    workspace_id: z.string().uuid().optional(),
    lead_status: z.enum(["contato", "resposta", "follow_up", "fechamento"]).optional(),
    product_interest: z.string().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(50).optional().default(25),
    offset: z.number().int().min(0).optional().default(0),
    redact: z.boolean().optional().default(true),
  })
  .strict();

export const listLeads: ActionDef = {
  description:
    "Lista leads do CRM. PII (phone/email) redacted por padrao (****1234, j***@dominio). Para PII completa use {redact:false} (auditavel).",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace_id: { type: "string", format: "uuid" },
      lead_status: { type: "string", enum: ["contato", "resposta", "follow_up", "fechamento"] },
      product_interest: { type: "string", minLength: 1, maxLength: 100 },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 25 },
      offset: { type: "integer", minimum: 0, default: 0 },
      redact: { type: "boolean", default: true },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    let query = supabase
      .from("crm_leads")
      .select(
        "id, workspace_id, name, store_name, phone, email, lead_status, lead_score, product_interest, observations, site_url, revenue, created_at",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(params.offset, params.offset + params.limit - 1);
    if (params.workspace_id) query = query.eq("workspace_id", params.workspace_id);
    if (params.lead_status) query = query.eq("lead_status", params.lead_status);
    if (params.product_interest) query = query.ilike("product_interest", `%${params.product_interest}%`);

    const { data, error, count } = await query;
    if (error) {
      const e = new Error(`Falha ao listar leads: ${error.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    const leads = (data ?? []).map((lead) =>
      params.redact
        ? { ...lead, phone: redactPhone(lead.phone), email: redactEmail(lead.email) }
        : lead,
    );
    return {
      leads,
      page: { offset: params.offset, limit: params.limit, total: count ?? null },
      redacted: params.redact,
    };
  },
};
