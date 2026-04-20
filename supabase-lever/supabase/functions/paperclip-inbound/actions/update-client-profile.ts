import { z } from "zod";
import type { ActionDef } from "../registry.ts";

// Allow-list para Paperclip: campos NAO-financeiros do cliente.
// Campos financeiros (fee_fixed, commission_rate, profit_*) ficam de fora —
// requerem update_client_commercial separado (alto risco, nao implementado neste ciclo).
const patchSchema = z
  .object({
    project_name: z.string().min(1).max(200).nullable().optional(),
    project_deadline: z.string().datetime().nullable().optional(),
    primary_color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, "primary_color deve ser hex #RRGGBB")
      .nullable()
      .optional(),
    payment_due_day: z.number().int().min(1).max(28).nullable().optional(),
    is_archived: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "patch nao pode ser vazio" });

const paramsSchema = z
  .object({
    client_id: z.string().uuid(),
    patch: patchSchema,
  })
  .strict();

export const updateClientProfile: ActionDef = {
  description:
    "Atualiza campos NAO-financeiros do cliente (project_name, project_deadline, primary_color, payment_due_day, is_archived). Campos financeiros (fee, commission) precisam de acao separada.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["client_id", "patch"],
    properties: {
      client_id: { type: "string", format: "uuid" },
      patch: {
        type: "object",
        additionalProperties: false,
        properties: {
          project_name: { type: ["string", "null"], minLength: 1, maxLength: 200 },
          project_deadline: { type: ["string", "null"], format: "date-time" },
          primary_color: { type: ["string", "null"], pattern: "^#[0-9A-Fa-f]{6}$" },
          payment_due_day: { type: ["integer", "null"], minimum: 1, maximum: 28 },
          is_archived: { type: "boolean" },
        },
      },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    const { data, error } = await supabase
      .from("agency_clients")
      .update(params.patch)
      .eq("id", params.client_id)
      .select(
        "id, name, project_name, project_deadline, primary_color, payment_due_day, is_archived",
      )
      .maybeSingle();
    if (error) {
      const e = new Error(`Falha ao atualizar cliente: ${error.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    if (!data) {
      const e = new Error(`Cliente ${params.client_id} nao encontrado`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "client_not_found";
      e.httpStatus = 422;
      throw e;
    }
    return { client: data, applied_patch: params.patch };
  },
};
