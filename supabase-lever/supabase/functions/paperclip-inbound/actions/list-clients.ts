import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    workspace_id: z.string().uuid().optional(),
    include_archived: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(50).optional().default(20),
    offset: z.number().int().min(0).optional().default(0),
  })
  .strict();

export const listClients: ActionDef = {
  description:
    "Lista clientes paginado (max 50/pagina). Sem tokens sensiveis. Filtros: workspace_id, include_archived.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace_id: { type: "string", format: "uuid" },
      include_archived: { type: "boolean", default: false },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      offset: { type: "integer", minimum: 0, default: 0 },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    let query = supabase
      .from("agency_clients")
      .select(
        "id, workspace_id, name, client_type, project_name, project_deadline, is_archived, created_at, primary_color, payment_due_day, shopify_status, cartpanda_status, onboarding_type",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(params.offset, params.offset + params.limit - 1);
    if (params.workspace_id) query = query.eq("workspace_id", params.workspace_id);
    if (!params.include_archived) query = query.eq("is_archived", false);
    const { data, error, count } = await query;
    if (error) {
      const e = new Error(`Falha ao listar clientes: ${error.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    return {
      clients: data ?? [],
      page: { offset: params.offset, limit: params.limit, total: count ?? null },
    };
  },
};
