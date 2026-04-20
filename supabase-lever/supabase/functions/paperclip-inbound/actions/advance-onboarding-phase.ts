import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z.object({ onboarding_id: z.string().uuid() }).strict();

export const advanceOnboardingPhase: ActionDef = {
  description:
    "Avanca o onboarding para a proxima fase. Valida que TODAS as tasks is_required=true da fase atual estao concluido. Marca fase atual como concluida, proxima como em_andamento, atualiza onboarding.current_phase, grava timeline.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["onboarding_id"],
    properties: { onboarding_id: { type: "string", format: "uuid" } },
  },
  handler: async (raw, { supabase, actor }) => {
    const params = paramsSchema.parse(raw);

    const { data: onboarding, error: oErr } = await supabase
      .from("onboarding")
      .select("id, current_phase, status")
      .eq("id", params.onboarding_id)
      .maybeSingle();
    if (oErr) {
      const e = new Error(`Falha buscando onboarding: ${oErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    if (!onboarding) {
      const e = new Error(`Onboarding ${params.onboarding_id} nao encontrado`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "onboarding_not_found";
      e.httpStatus = 422;
      throw e;
    }
    if (onboarding.status === "concluido") {
      const e = new Error("Onboarding ja esta concluido") as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "onboarding_already_done";
      e.httpStatus = 422;
      throw e;
    }

    const { data: phases, error: pErr } = await supabase
      .from("onboarding_phases")
      .select("id, phase_key, phase_name, phase_order, status")
      .eq("onboarding_id", params.onboarding_id)
      .order("phase_order", { ascending: true });
    if (pErr || !phases || phases.length === 0) {
      const e = new Error("Onboarding sem fases") as Error & { code?: string; httpStatus?: number };
      e.code = "no_phases";
      e.httpStatus = 422;
      throw e;
    }

    const currentIdx = phases.findIndex((p) => p.status === "em_andamento");
    if (currentIdx < 0) {
      const e = new Error("Nenhuma fase em_andamento para avancar") as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "no_active_phase";
      e.httpStatus = 422;
      throw e;
    }
    const currentPhase = phases[currentIdx];
    const nextPhase = phases[currentIdx + 1];

    // Valida tasks obrigatorias da fase atual
    const { data: requiredTasks, error: rtErr } = await supabase
      .from("onboarding_tasks")
      .select("id, task_name, status")
      .eq("phase_id", currentPhase.id)
      .eq("is_required", true);
    if (rtErr) {
      const e = new Error(`Falha buscando tasks obrigatorias: ${rtErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    const incomplete = (requiredTasks ?? []).filter((t) => t.status !== "concluido");
    if (incomplete.length > 0) {
      const e = new Error(
        `Fase ${currentPhase.phase_name} tem ${incomplete.length} task(s) obrigatoria(s) nao concluida(s)`,
      ) as Error & { code?: string; httpStatus?: number; details?: unknown };
      e.code = "required_tasks_pending";
      e.httpStatus = 422;
      e.details = { incomplete_tasks: incomplete };
      throw e;
    }

    const nowIso = new Date().toISOString();

    await supabase
      .from("onboarding_phases")
      .update({ status: "concluido", completed_at: nowIso })
      .eq("id", currentPhase.id);

    if (nextPhase) {
      await supabase
        .from("onboarding_phases")
        .update({ status: "em_andamento", started_at: nowIso })
        .eq("id", nextPhase.id);
      await supabase
        .from("onboarding")
        .update({ current_phase: nextPhase.phase_key })
        .eq("id", params.onboarding_id);
    } else {
      await supabase
        .from("onboarding")
        .update({ status: "concluido", completed_at: nowIso, current_phase: null })
        .eq("id", params.onboarding_id);
    }

    await supabase.from("onboarding_timeline").insert([
      {
        onboarding_id: params.onboarding_id,
        event_type: "phase_completed",
        event_data: {
          phase_key: currentPhase.phase_key,
          phase_name: currentPhase.phase_name,
          actor: actor ?? "paperclip",
        },
      },
      ...(nextPhase
        ? [
            {
              onboarding_id: params.onboarding_id,
              event_type: "phase_started",
              event_data: {
                phase_key: nextPhase.phase_key,
                phase_name: nextPhase.phase_name,
                actor: actor ?? "paperclip",
              },
            },
          ]
        : []),
    ]);

    return {
      previous_phase: { key: currentPhase.phase_key, name: currentPhase.phase_name },
      next_phase: nextPhase
        ? { key: nextPhase.phase_key, name: nextPhase.phase_name }
        : null,
      onboarding_completed: !nextPhase,
    };
  },
};
