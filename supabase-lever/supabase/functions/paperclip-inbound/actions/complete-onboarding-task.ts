import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    onboarding_task_id: z.string().uuid(),
    note: z.string().min(10).max(1000),
  })
  .strict();

export const completeOnboardingTask: ActionDef = {
  description:
    "Marca uma onboarding_task como concluida + grava evento task_completed na onboarding_timeline com note (min 10 chars) justificando.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["onboarding_task_id", "note"],
    properties: {
      onboarding_task_id: { type: "string", format: "uuid" },
      note: { type: "string", minLength: 10, maxLength: 1000 },
    },
  },
  handler: async (raw, { supabase, actor }) => {
    const params = paramsSchema.parse(raw);

    const { data: task, error: tErr } = await supabase
      .from("onboarding_tasks")
      .select("id, phase_id, task_name, status")
      .eq("id", params.onboarding_task_id)
      .maybeSingle();
    if (tErr) {
      const e = new Error(`Falha ao buscar onboarding_task: ${tErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    if (!task) {
      const e = new Error(`onboarding_task ${params.onboarding_task_id} nao encontrada`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "task_not_found";
      e.httpStatus = 422;
      throw e;
    }
    if (task.status === "concluido") {
      return {
        task: { id: task.id, status: "concluido" },
        message: "Task ja estava concluida; nenhuma mudanca aplicada",
      };
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: uErr } = await supabase
      .from("onboarding_tasks")
      .update({ status: "concluido", completed_at: nowIso })
      .eq("id", params.onboarding_task_id)
      .select("id, task_name, status, completed_at, phase_id")
      .single();
    if (uErr) {
      const e = new Error(`Falha ao concluir task: ${uErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }

    // Recuperar onboarding_id pela phase
    const { data: phase, error: pErr } = await supabase
      .from("onboarding_phases")
      .select("onboarding_id")
      .eq("id", updated.phase_id)
      .maybeSingle();
    if (pErr || !phase) {
      const e = new Error("Falha ao resolver onboarding_id pela fase") as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "phase_not_found";
      e.httpStatus = 422;
      throw e;
    }

    await supabase.from("onboarding_timeline").insert({
      onboarding_id: phase.onboarding_id,
      event_type: "task_completed",
      event_data: {
        task_id: updated.id,
        task_name: updated.task_name,
        note: params.note,
        completed_by_paperclip: true,
        actor: actor ?? "paperclip",
      },
    });

    return { task: updated, timeline_recorded: true };
  },
};
