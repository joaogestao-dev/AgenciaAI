import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    task_id: z.string().uuid(),
    content: z.string().min(1).max(5000),
  })
  .strict();

export const addTaskComment: ActionDef = {
  description:
    "Adiciona comentario em uma tarefa. Prefixo [Paperclip:<actor>] adicionado automaticamente. user_id resolvido como owner do workspace da task.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task_id", "content"],
    properties: {
      task_id: { type: "string", format: "uuid" },
      content: { type: "string", minLength: 1, maxLength: 5000 },
    },
  },
  handler: async (raw, { supabase, actor }) => {
    const params = paramsSchema.parse(raw);

    const { data: task, error: tErr } = await supabase
      .from("client_tasks")
      .select("id, workspace_id")
      .eq("id", params.task_id)
      .maybeSingle();
    if (tErr) {
      const e = new Error(`Falha buscando task: ${tErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    if (!task) {
      const e = new Error(`Task ${params.task_id} nao encontrada`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "task_not_found";
      e.httpStatus = 422;
      throw e;
    }

    const { data: workspace, error: wErr } = await supabase
      .from("workspaces")
      .select("owner_id")
      .eq("id", task.workspace_id)
      .maybeSingle();
    if (wErr || !workspace?.owner_id) {
      const e = new Error("Nao foi possivel resolver owner do workspace para autorar comentario") as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "workspace_owner_missing";
      e.httpStatus = 422;
      throw e;
    }

    const actorTag = actor ?? "paperclip";
    const prefixedContent = `[Paperclip:${actorTag}] ${params.content}`;

    const { data: inserted, error: insErr } = await supabase
      .from("task_comments")
      .insert({
        task_id: params.task_id,
        user_id: workspace.owner_id,
        user_name: `Paperclip:${actorTag}`,
        content: prefixedContent,
      })
      .select("id, task_id, user_id, user_name, content, created_at")
      .single();
    if (insErr) {
      const e = new Error(`Falha ao inserir comentario: ${insErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    return { comment: inserted };
  },
};
