import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    workspace_id: z.string().uuid().optional(),
    user_type: z.enum(["agency", "client"]).optional(),
    status: z.enum(["pending", "active", "inactive"]).optional().default("active"),
    limit: z.number().int().min(1).max(100).optional().default(50),
  })
  .strict();

export const listTeamMembers: ActionDef = {
  description:
    "Lista membros do time. Campos enxutos: id, name, email, role, user_type, status. NUNCA expoe base_salary, commission_rate, pix_key.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace_id: { type: "string", format: "uuid" },
      user_type: { type: "string", enum: ["agency", "client"] },
      status: { type: "string", enum: ["pending", "active", "inactive"], default: "active" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    let query = supabase
      .from("team_members")
      .select("id, workspace_id, user_id, name, email, role, user_type, status, joined_at, linked_client_id")
      .eq("status", params.status)
      .order("joined_at", { ascending: false, nullsFirst: false })
      .limit(params.limit);
    if (params.workspace_id) query = query.eq("workspace_id", params.workspace_id);
    if (params.user_type) query = query.eq("user_type", params.user_type);
    const { data, error } = await query;
    if (error) {
      const e = new Error(`Falha ao listar membros: ${error.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    return { members: data ?? [], count: (data ?? []).length };
  },
};
