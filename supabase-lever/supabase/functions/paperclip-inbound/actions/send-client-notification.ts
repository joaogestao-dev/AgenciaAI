import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    user_id: z.string().uuid(),
    workspace_id: z.string().uuid().optional(),
    type: z.string().min(1).max(50).default("paperclip"),
    title: z.string().min(1).max(200),
    message: z.string().min(1).max(2000).optional().nullable(),
    link: z.string().max(500).optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const sendClientNotification: ActionDef = {
  description:
    "Cria uma notificacao para um usuario (in-app, painel de notifications). NAO envia WhatsApp/email — so o registro em notifications. Trigger frontend mostra ao usuario.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["user_id", "title"],
    properties: {
      user_id: { type: "string", format: "uuid" },
      workspace_id: { type: "string", format: "uuid" },
      type: { type: "string", minLength: 1, maxLength: 50, default: "paperclip" },
      title: { type: "string", minLength: 1, maxLength: 200 },
      message: { type: ["string", "null"], minLength: 1, maxLength: 2000 },
      link: { type: ["string", "null"], maxLength: 500 },
      metadata: { type: ["object", "null"] },
    },
  },
  handler: async (raw, { supabase, actor }) => {
    const params = paramsSchema.parse(raw);
    const meta = { ...(params.metadata ?? {}), source: "paperclip", actor: actor ?? "paperclip" };
    const { data, error } = await supabase
      .from("notifications")
      .insert({
        user_id: params.user_id,
        workspace_id: params.workspace_id ?? null,
        type: params.type,
        title: params.title,
        message: params.message ?? null,
        link: params.link ?? null,
        metadata: meta,
        is_read: false,
      })
      .select("id, user_id, workspace_id, type, title, created_at")
      .single();
    if (error) {
      const e = new Error(`Falha ao criar notificacao: ${error.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    return { notification: data };
  },
};
