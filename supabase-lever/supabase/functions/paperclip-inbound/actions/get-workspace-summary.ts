import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    workspace_id: z.string().uuid().optional(),
  })
  .strict();

export const getWorkspaceSummary: ActionDef = {
  description:
    "Retorna sumario operacional do workspace (contadores de clientes, tasks, leads, invoices, team, demand_requests, onboarding + 5 notificacoes recentes). Se workspace_id ausente, usa o unico workspace do banco (fallback para single-tenant).",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    properties: { workspace_id: { type: "string", format: "uuid" } },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);
    let workspaceId = params.workspace_id;
    if (!workspaceId) {
      const { data: ws, error: wsErr } = await supabase
        .from("workspaces")
        .select("id")
        .order("created_at", { ascending: true })
        .limit(2);
      if (wsErr) {
        const e = new Error(`Falha ao listar workspaces: ${wsErr.message}`) as Error & {
          code?: string;
          httpStatus?: number;
        };
        e.code = "db_error";
        e.httpStatus = 422;
        throw e;
      }
      if (!ws || ws.length === 0) {
        const e = new Error("Nenhum workspace encontrado") as Error & {
          code?: string;
          httpStatus?: number;
        };
        e.code = "no_workspace";
        e.httpStatus = 422;
        throw e;
      }
      if (ws.length > 1) {
        const e = new Error("Multiplos workspaces existem; informe workspace_id explicitamente") as Error & {
          code?: string;
          httpStatus?: number;
        };
        e.code = "ambiguous_workspace";
        e.httpStatus = 422;
        throw e;
      }
      workspaceId = ws[0].id;
    }
    const { data, error } = await supabase.rpc("paperclip_workspace_summary", {
      p_workspace_id: workspaceId,
    });
    if (error) {
      const e = new Error(`Falha na RPC paperclip_workspace_summary: ${error.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    return { summary: data };
  },
};
