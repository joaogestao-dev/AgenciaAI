import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    lead_id: z.string().uuid(),
    lead_status: z.enum(["contato", "resposta", "follow_up", "fechamento"]),
  })
  .strict();

export const updateLeadStatus: ActionDef = {
  description: "Atualiza o lead_status (move no kanban do CRM). Valores: contato, resposta, follow_up, fechamento.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["lead_id", "lead_status"],
    properties: {
      lead_id: { type: "string", format: "uuid" },
      lead_status: { type: "string", enum: ["contato", "resposta", "follow_up", "fechamento"] },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    const { data, error } = await supabase
      .from("crm_leads")
      .update({ lead_status: params.lead_status })
      .eq("id", params.lead_id)
      .select("id, name, lead_status")
      .maybeSingle();
    if (error) {
      const e = new Error(`Falha atualizando lead: ${error.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    if (!data) {
      const e = new Error(`Lead ${params.lead_id} nao encontrado`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "lead_not_found";
      e.httpStatus = 422;
      throw e;
    }
    return { lead: data };
  },
};
