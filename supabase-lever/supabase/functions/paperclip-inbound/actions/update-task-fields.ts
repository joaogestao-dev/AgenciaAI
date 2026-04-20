import { z } from "zod";
import type { ActionDef } from "../registry.ts";

// Allow-list estrita: campos que Paperclip pode mutar diretamente.
// status NAO esta aqui (use update_client_task_status), assignee NAO esta
// (use assign_task), title/client_id/workspace_id NAO sao mutaveis.
const patchSchema = z
  .object({
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    area: z.enum(["strategy", "traffic", "design", "dev"]).nullable().optional(),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date deve ser YYYY-MM-DD")
      .nullable()
      .optional(),
    description: z.string().max(10000).nullable().optional(),
    checklist: z
      .array(z.object({ title: z.string().min(1).max(200), done: z.boolean().default(false) }))
      .max(50)
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "patch nao pode ser vazio" });

const paramsSchema = z
  .object({
    task_id: z.string().uuid(),
    patch: patchSchema,
  })
  .strict();

export const updateTaskFields: ActionDef = {
  description:
    "Atualiza campos especificos de uma tarefa via patch (allow-list estrita: priority, area, due_date, description, checklist). Para status use update_client_task_status; para assignee use assign_task.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task_id", "patch"],
    properties: {
      task_id: { type: "string", format: "uuid" },
      patch: {
        type: "object",
        additionalProperties: false,
        properties: {
          priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
          area: { type: ["string", "null"], enum: ["strategy", "traffic", "design", "dev", null] },
          due_date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          description: { type: ["string", "null"], maxLength: 10000 },
          checklist: { type: "array", maxItems: 50 },
        },
      },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    const patch = { ...params.patch, updated_at: new Date().toISOString() };
    const { data, error } = await supabase
      .from("client_tasks")
      .update(patch)
      .eq("id", params.task_id)
      .select("id, title, priority, area, due_date, description, checklist, updated_at")
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
    return { task: data, applied_patch: params.patch };
  },
};
