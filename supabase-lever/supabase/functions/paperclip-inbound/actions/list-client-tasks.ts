import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    client_id: z.string().uuid(),
    status: z.enum(["pending", "in_progress", "completed", "blocked"]).optional(),
    assignee_id: z.string().uuid().optional().nullable(),
    limit: z.number().int().min(1).max(100).optional().default(50),
  })
  .strict();

export const listClientTasks: ActionDef = {
  description: "Lista tarefas de um cliente. Filtros opcionais: status, assignee_id. Max 100.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["client_id"],
    properties: {
      client_id: { type: "string", format: "uuid" },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
      assignee_id: { type: ["string", "null"], format: "uuid" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    let query = supabase
      .from("client_tasks")
      .select(
        "id, client_id, workspace_id, title, status, priority, area, assignee_id, due_date, completed_at, created_at, updated_at, source, product_name",
      )
      .eq("client_id", params.client_id)
      .order("created_at", { ascending: false })
      .limit(params.limit);
    if (params.status) query = query.eq("status", params.status);
    if (params.assignee_id !== undefined) {
      if (params.assignee_id === null) query = query.is("assignee_id", null);
      else query = query.eq("assignee_id", params.assignee_id);
    }
    const { data, error } = await query;
    if (error) {
      const e = new Error(`Falha ao listar tarefas: ${error.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    return { tasks: data ?? [], count: (data ?? []).length };
  },
};
