import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    workspace_id: z.string().uuid(),
    name: z.string().min(1).max(200),
    phone: z.string().max(50).optional().nullable(),
    email: z.string().email().max(200).optional().nullable(),
    store_name: z.string().max(200).optional().nullable(),
    product_interest: z.string().max(200).optional().nullable(),
    observations: z.string().max(5000).optional().nullable(),
    site_url: z.string().url().max(500).optional().nullable(),
    revenue: z.string().max(100).optional().nullable(),
    lead_status: z.enum(["contato", "resposta", "follow_up", "fechamento"]).optional().default("contato"),
  })
  .strict()
  .refine((v) => !!(v.phone || v.email), {
    message: "Forneca pelo menos phone ou email para detectar duplicatas",
  });

export const createLead: ActionDef = {
  description:
    "Cria lead no CRM. Dedup por email/phone (mesma workspace) — se ja existe, retorna o lead existente sem criar duplicata. Sem trigger automatico para outros sistemas.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["workspace_id", "name"],
    properties: {
      workspace_id: { type: "string", format: "uuid" },
      name: { type: "string", minLength: 1, maxLength: 200 },
      phone: { type: ["string", "null"], maxLength: 50 },
      email: { type: ["string", "null"], format: "email", maxLength: 200 },
      store_name: { type: ["string", "null"], maxLength: 200 },
      product_interest: { type: ["string", "null"], maxLength: 200 },
      observations: { type: ["string", "null"], maxLength: 5000 },
      site_url: { type: ["string", "null"], format: "uri", maxLength: 500 },
      revenue: { type: ["string", "null"], maxLength: 100 },
      lead_status: { type: "string", enum: ["contato", "resposta", "follow_up", "fechamento"], default: "contato" },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);

    let dupQuery = supabase
      .from("crm_leads")
      .select("id, name, phone, email, lead_status, created_at")
      .eq("workspace_id", params.workspace_id)
      .limit(1);
    if (params.email && params.phone) {
      dupQuery = dupQuery.or(`email.ilike.${params.email},phone.eq.${params.phone}`);
    } else if (params.email) {
      dupQuery = dupQuery.ilike("email", params.email);
    } else if (params.phone) {
      dupQuery = dupQuery.eq("phone", params.phone);
    }
    const { data: existing, error: dupErr } = await dupQuery;
    if (dupErr) {
      const e = new Error(`Falha checando duplicata: ${dupErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    if (existing && existing.length > 0) {
      return {
        lead: existing[0],
        created: false,
        reason: "Lead com mesmo email/phone ja existe neste workspace",
      };
    }

    const { data: inserted, error: insErr } = await supabase
      .from("crm_leads")
      .insert({
        workspace_id: params.workspace_id,
        name: params.name,
        phone: params.phone ?? null,
        email: params.email ?? null,
        store_name: params.store_name ?? null,
        product_interest: params.product_interest ?? null,
        observations: params.observations ?? null,
        site_url: params.site_url ?? null,
        revenue: params.revenue ?? null,
        lead_status: params.lead_status,
      })
      .select("id, name, phone, email, lead_status, created_at, workspace_id")
      .single();
    if (insErr) {
      const e = new Error(`Falha ao criar lead: ${insErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    return { lead: inserted, created: true };
  },
};
