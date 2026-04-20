import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    task_id: z.string().uuid(),
    status: z.enum(["pending", "completed"]),
  })
  .strict();

export const updateClientTaskStatus: ActionDef = {
  description:
    "Atualiza o status de uma tarefa (pending|completed). Quando completed, seta completed_at=now(); quando pending, limpa.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task_id", "status"],
    properties: {
      task_id: { type: "string", format: "uuid" },
      status: { type: "string", enum: ["pending", "completed"] },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = {
      status: params.status,
      updated_at: nowIso,
      completed_at: params.status === "completed" ? nowIso : null,
    };
    const { data, error } = await supabase
      .from("client_tasks")
      .update(patch)
      .eq("id", params.task_id)
      .select("id, status, title, updated_at, completed_at")
      .maybeSingle();
    if (error) {
      const e = new Error(`Falha ao atualizar task: ${error.message}`) as Error & {
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
