import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    client_id: z.string().uuid(),
    title: z.string().min(1).max(500),
    description: z.string().max(10000).optional().nullable(),
    priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
    area: z.enum(["strategy", "traffic", "design", "dev"]).optional().nullable(),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date deve ser YYYY-MM-DD")
      .optional()
      .nullable(),
    checklist: z
      .array(
        z.object({
          title: z.string().min(1).max(200),
          done: z.boolean().default(false),
        }),
      )
      .max(50)
      .optional(),
    product_id: z.string().max(100).optional().nullable(),
    product_name: z.string().max(200).optional().nullable(),
  })
  .strict();

export const createClientTask: ActionDef = {
  description:
    "Cria uma tarefa para um cliente. Source = 'paperclip'. workspace_id e resolvido automaticamente pelo cliente.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["client_id", "title"],
    properties: {
      client_id: { type: "string", format: "uuid" },
      title: { type: "string", minLength: 1, maxLength: 500 },
      description: { type: ["string", "null"], maxLength: 10000 },
      priority: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium" },
      area: { type: ["string", "null"], enum: ["strategy", "traffic", "design", "dev", null] },
      due_date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      checklist: { type: "array", maxItems: 50 },
      product_id: { type: ["string", "null"] },
      product_name: { type: ["string", "null"] },
    },
  },
  handler: async (raw, { supabase, actor }) => {
    const params = paramsSchema.parse(raw);

    const { data: client, error: clientErr } = await supabase
      .from("agency_clients")
      .select("id, workspace_id, name")
      .eq("id", params.client_id)
      .maybeSingle();
    if (clientErr) {
      const e = new Error(`Erro ao buscar cliente: ${clientErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    if (!client) {
      const e = new Error(`Cliente ${params.client_id} nao encontrado`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "client_not_found";
      e.httpStatus = 422;
      throw e;
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("client_tasks")
      .insert({
        client_id: client.id,
        workspace_id: client.workspace_id,
        title: params.title,
        description: params.description ?? null,
        priority: params.priority,
        status: "pending",
        area: params.area ?? null,
        due_date: params.due_date ?? null,
        checklist: params.checklist ?? [],
        product_id: params.product_id ?? null,
        product_name: params.product_name ?? null,
        source: "paperclip",
      })
      .select("id, client_id, workspace_id, title, status, priority, created_at")
      .single();
    if (insertErr) {
      const e = new Error(`Falha ao criar task: ${insertErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }

    return {
      task_id: inserted.id,
      client_id: inserted.client_id,
      client_name: client.name,
      workspace_id: inserted.workspace_id,
      status: inserted.status,
      priority: inserted.priority,
      created_at: inserted.created_at,
      created_by: actor ?? "paperclip",
    };
  },
};
