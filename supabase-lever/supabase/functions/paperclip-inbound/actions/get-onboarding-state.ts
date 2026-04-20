import { z } from "zod";
import type { ActionDef } from "../registry.ts";

const paramsSchema = z
  .object({
    client_id: z.string().uuid(),
    timeline_limit: z.number().int().min(1).max(50).optional().default(20),
  })
  .strict();

export const getOnboardingState: ActionDef = {
  description:
    "Estado completo de onboarding de um cliente: registro principal + fases (com tasks aninhadas) + ultimas N entradas da timeline.",
  paramsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["client_id"],
    properties: {
      client_id: { type: "string", format: "uuid" },
      timeline_limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
  },
  handler: async (raw, { supabase }) => {
    const params = paramsSchema.parse(raw);

    const { data: onboarding, error: oErr } = await supabase
      .from("onboarding")
      .select(
        "id, client_id, type, status, current_phase, started_at, completed_at, assigned_cs, assigned_designer, assigned_traffic, assigned_tech, whatsapp_group_created, portal_access_granted, briefing_id, notes, created_at, updated_at",
      )
      .eq("client_id", params.client_id)
      .order("created_at", { ascending: false })
      .maybeSingle();
    if (oErr) {
      const e = new Error(`Falha ao buscar onboarding: ${oErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }
    if (!onboarding) return { onboarding: null, phases: [], timeline: [] };

    const { data: phases, error: pErr } = await supabase
      .from("onboarding_phases")
      .select(
        "id, phase_key, phase_name, phase_order, parallel_group, status, started_at, completed_at, due_date, due_days_limit",
      )
      .eq("onboarding_id", onboarding.id)
      .order("phase_order", { ascending: true });
    if (pErr) {
      const e = new Error(`Falha ao buscar fases: ${pErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }

    const phaseIds = (phases ?? []).map((p) => p.id);
    const { data: tasks, error: tErr } = phaseIds.length
      ? await supabase
          .from("onboarding_tasks")
          .select(
            "id, phase_id, task_key, task_name, task_description, is_required, status, completed_by, completed_at, task_order, depends_on, estimated_minutes, assigned_to",
          )
          .in("phase_id", phaseIds)
          .order("task_order", { ascending: true })
      : { data: [], error: null };
    if (tErr) {
      const e = new Error(`Falha ao buscar tasks: ${tErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }

    const phasesWithTasks = (phases ?? []).map((p) => ({
      ...p,
      tasks: (tasks ?? []).filter((t) => t.phase_id === p.id),
    }));

    const { data: timeline, error: tlErr } = await supabase
      .from("onboarding_timeline")
      .select("id, event_type, event_data, performed_by, created_at")
      .eq("onboarding_id", onboarding.id)
      .order("created_at", { ascending: false })
      .limit(params.timeline_limit);
    if (tlErr) {
      const e = new Error(`Falha ao buscar timeline: ${tlErr.message}`) as Error & {
        code?: string;
        httpStatus?: number;
      };
      e.code = "db_error";
      e.httpStatus = 422;
      throw e;
    }

    return { onboarding, phases: phasesWithTasks, timeline: timeline ?? [] };
  },
};
