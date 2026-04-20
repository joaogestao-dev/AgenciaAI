import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    task_id: z.string().uuid(),
    assignee_user_id: z.string().uuid().nullable(),
  })
  .strict();

export const assignTask: ActionDef = {
  description:
    "Atribui (ou desatribui) uma tarefa a um usuario. Passar assignee_user_id=null remove o assignee. Trigger DB notify_on_task_assign dispara notificacao.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task_id", "assignee_user_id"],
    properties: {
      task_id: { type: "string", format: "uuid" },
      assignee_user_id: { type: ["string", "null"], format: "uuid" },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);

    if (params.assignee_user_id !== null) {
      const { data: member, error: mErr } = await supabase
        .from("team_members")
        .select("id, user_id, status")
        .eq("user_id", params.assignee_user_id)
        .eq("status", "active")
        .maybeSingle();
      if (mErr) {
        const e = new Error(`Falha validando assignee: ${mErr.message}`) as Error & {
          code?: string;
          httpStatus?: number;
        };
        e.code = "db_error";
        e.httpStatus = 422;
        throw e;
      }
      if (!member) {
        const e = new Error(`Usuario ${params.assignee_user_id} nao e team_member ativo`) as Error & {
          code?: string;
          httpStatus?: number;
        };
        e.code = "assignee_invalid";
        e.httpStatus = 422;
        throw e;
      }
    }

    const { data, error } = await supabase
      .from("client_tasks")
      .update({ assignee_id: params.assignee_user_id, updated_at: new Date().toISOString() })
      .eq("id", params.task_id)
      .select("id, title, assignee_id, status, updated_at")
      .maybeSingle();
    if (error) {
      const e = new Error(`Falha ao atribuir task: ${error.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    if (!data) {
      const e = new Error(`Task ${params.task_id} nao encontrada`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "task_not_found";
      e.httpStatus = 422;
      throw e;
    }
    return { task: data };
  },
};
