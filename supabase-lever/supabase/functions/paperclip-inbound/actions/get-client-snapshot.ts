import { z } from "zod";
import type { ActionDef } from "../registry.ts";

// agency_clients NAO tem coluna 'email' (validado contra schema real).
// Filtros disponiveis: client_id (UUID exato) ou name_contains (busca parcial).
const paramsSchema = z
  .object({
    client_id: z.string().uuid().optional(),
    name_contains: z.string().min(2).max(100).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).filter(Boolean).length === 1, {
    message: "Forneca exatamente um filtro: client_id | name_contains",
  });

export const getClientSnapshot: ActionDef = {
  description:
    "Retorna ate 10 clientes que casam com client_id (UUID) ou name_contains (busca parcial). Sem tokens sensiveis.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      client_id: { type: "string", format: "uuid" },
      name_contains: { type: "string", minLength: 2, maxLength: 100 },
    },
    description: "Forneca exatamente um filtro",
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    let query = supabase
      .from("agency_clients")
      .select(
        "id, workspace_id, name, client_type, project_name, project_deadline, is_archived, created_at, primary_color, payment_due_day, fee_fixed, commission_rate, shopify_status, cartpanda_status, onboarding_type",
      )
      .order("created_at", { ascending: false })
      .limit(10);
    if (params.client_id) query = query.eq("id", params.client_id);
    else if (params.name_contains) query = query.ilike("name", `%${params.name_contains}%`);
    const { data, error } = await query;
    if (error) {
      const e = new Error(`Falha ao consultar agency_clients: ${error.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    return { clients: data ?? [], count: (data ?? []).length };
  },
};
