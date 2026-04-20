/**
 * Webhook route: POST /api/webhooks/lever-events
 *
 * Event bus inbound do Lever. Aceita envelope discriminado por `event_type`.
 * Cada tipo decide se vira Issue (acorda agente) ou apenas Activity Log.
 *
 * Tipos suportados (v2):
 *   - task.created               → cria Issue + acorda agente (comportamento original)
 *   - client.created             → Activity Log
 *   - briefing.completed         → cria Issue (revisão estratégica) + Activity Log
 *   - demand.created             → cria Issue (demanda do cliente vira tarefa) + acorda
 *   - onboarding.phase.advanced  → Activity Log
 *   - lead.converted             → Activity Log
 *
 * Compatibilidade:
 *   Payloads sem `event_type` são tratados como `task.created` legacy
 *   até 2026-05-16, com warning de deprecação no log. Após essa data,
 *   serão rejeitados com 400.
 */

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@paperclipai/shared";
import { issueService, heartbeatService, logActivity } from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

const LEGACY_DEPRECATION_DATE = "2026-05-16";

// ── Schemas por tipo de evento ────────────────────────────────────────

const taskCreatedSchema = z.object({
  event_type: z.literal("task.created"),
  title: z.string().min(1, "title é obrigatório"),
  description: z.string().optional().nullable(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  status: z.enum(ISSUE_STATUSES).optional().default("todo"),
  companyId: z.string().uuid("companyId deve ser UUID válido"),
  assigneeAgentId: z.string().uuid("assigneeAgentId deve ser UUID válido"),
  source_agent: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const clientCreatedSchema = z.object({
  event_type: z.literal("client.created"),
  companyId: z.string().uuid(),
  client_id: z.string().uuid(),
  client_name: z.string().min(1),
  client_type: z.string().optional().nullable(),
  source_agent: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const briefingCompletedSchema = z.object({
  event_type: z.literal("briefing.completed"),
  companyId: z.string().uuid(),
  assigneeAgentId: z.string().uuid("assigneeAgentId é obrigatório para revisão estratégica"),
  briefing_id: z.string().uuid(),
  client_id: z.string().uuid(),
  client_name: z.string().min(1),
  ai_summary: z.string().optional().nullable(),
  source_agent: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const demandCreatedSchema = z.object({
  event_type: z.literal("demand.created"),
  companyId: z.string().uuid(),
  assigneeAgentId: z.string().uuid(),
  demand_id: z.string().uuid(),
  client_id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  area: z.string().optional().nullable(),
  source_agent: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const onboardingPhaseAdvancedSchema = z.object({
  event_type: z.literal("onboarding.phase.advanced"),
  companyId: z.string().uuid(),
  onboarding_id: z.string().uuid(),
  client_id: z.string().uuid(),
  from_phase: z.string().optional().nullable(),
  to_phase: z.string(),
  source_agent: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const leadConvertedSchema = z.object({
  event_type: z.literal("lead.converted"),
  companyId: z.string().uuid(),
  lead_id: z.string().uuid(),
  client_id: z.string().uuid(),
  lead_name: z.string().min(1),
  source_agent: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const eventEnvelopeSchema = z.discriminatedUnion("event_type", [
  taskCreatedSchema,
  clientCreatedSchema,
  briefingCompletedSchema,
  demandCreatedSchema,
  onboardingPhaseAdvancedSchema,
  leadConvertedSchema,
]);

type EventPayload = z.infer<typeof eventEnvelopeSchema>;

// Schema legacy (sem event_type) — equivalente ao task.created antigo
const legacyPayloadSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  status: z.enum(ISSUE_STATUSES).optional().default("todo"),
  companyId: z.string().uuid(),
  assigneeAgentId: z.string().uuid(),
  source_agent: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

function buildEnrichedDescription(
  base: string | null | undefined,
  source_agent: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  return (
    [
      base ?? "",
      source_agent ? `\n\n---\n**Origem:** ${source_agent}` : "",
      metadata ? `\n**Metadata:** \`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`` : "",
    ]
      .join("")
      .trim() || null
  );
}

function authenticate(req: Parameters<Parameters<Router["post"]>[1]>[0]): {
  ok: true;
} | { ok: false; status: number; error: string } {
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (!expectedSecret) {
    logger.error("WEBHOOK_SECRET não está definido — endpoint desabilitado");
    return { ok: false, status: 503, error: "Webhook endpoint não configurado" };
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Authorization Bearer ausente ou inválido" };
  }
  if (authHeader.slice(7) !== expectedSecret) {
    return { ok: false, status: 403, error: "Webhook secret inválido" };
  }
  return { ok: true };
}

function isLegacyDeprecationPassed(): boolean {
  return new Date() >= new Date(LEGACY_DEPRECATION_DATE);
}

export function webhookRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);
  const heartbeat = heartbeatService(db);

  router.post("/webhooks/lever-events", async (req, res) => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const rawBody: unknown = req.body ?? {};
    const hasEventType =
      typeof rawBody === "object" && rawBody !== null && "event_type" in (rawBody as object);

    let event: EventPayload;
    if (hasEventType) {
      const parsed = eventEnvelopeSchema.safeParse(rawBody);
      if (!parsed.success) {
        res.status(422).json({ error: "Payload inválido", details: parsed.error.issues });
        return;
      }
      event = parsed.data;
    } else {
      // Compatibilidade legacy: payload sem event_type vira task.created
      if (isLegacyDeprecationPassed()) {
        res.status(400).json({
          error: "Payload legacy (sem event_type) não é mais aceito",
          deprecated_since: LEGACY_DEPRECATION_DATE,
          required: "Inclua event_type. Tipos suportados: task.created, client.created, briefing.completed, demand.created, onboarding.phase.advanced, lead.converted",
        });
        return;
      }
      const parsed = legacyPayloadSchema.safeParse(rawBody);
      if (!parsed.success) {
        res.status(422).json({ error: "Payload legacy inválido", details: parsed.error.issues });
        return;
      }
      logger.warn(
        { deprecation_date: LEGACY_DEPRECATION_DATE },
        "Payload legacy sem event_type recebido — atualize o cliente para usar event_type='task.created'",
      );
      event = { event_type: "task.created", ...parsed.data };
    }

    try {
      const result = await dispatchEvent(event, { db, svc, heartbeat });
      res.status(result.status).json(result.body);
    } catch (err) {
      logger.error({ err, event_type: event.event_type }, "Falha processando evento Lever");
      res.status(500).json({ error: "Erro interno processando evento" });
    }
  });

  return router;
}

// ── Dispatcher por event_type ─────────────────────────────────────────

type DispatchCtx = {
  db: Db;
  svc: ReturnType<typeof issueService>;
  heartbeat: ReturnType<typeof heartbeatService>;
};

type DispatchResult = { status: number; body: Record<string, unknown> };

async function dispatchEvent(event: EventPayload, ctx: DispatchCtx): Promise<DispatchResult> {
  switch (event.event_type) {
    case "task.created":
      return await handleTaskCreated(event, ctx);
    case "demand.created":
      return await handleDemandCreated(event, ctx);
    case "briefing.completed":
      return await handleBriefingCompleted(event, ctx);
    case "client.created":
      return await handleClientCreated(event, ctx);
    case "onboarding.phase.advanced":
      return await handleOnboardingPhaseAdvanced(event, ctx);
    case "lead.converted":
      return await handleLeadConverted(event, ctx);
  }
}

async function handleTaskCreated(
  event: z.infer<typeof taskCreatedSchema>,
  { db, svc, heartbeat }: DispatchCtx,
): Promise<DispatchResult> {
  const enrichedDescription = buildEnrichedDescription(
    event.description,
    event.source_agent,
    event.metadata,
  );

  const issue = await svc.create(event.companyId, {
    title: event.title,
    description: enrichedDescription,
    priority: event.priority,
    status: event.status,
    assigneeAgentId: event.assigneeAgentId,
  });

  await logActivity(db, {
    companyId: event.companyId,
    actorType: "system",
    actorId: "webhook:lever-events",
    agentId: null,
    runId: null,
    action: "issue.created",
    entityType: "issue",
    entityId: issue.id,
    details: {
      title: issue.title,
      identifier: issue.identifier,
      source: "webhook:lever-events",
      source_agent: event.source_agent ?? null,
      event_type: event.event_type,
    },
  });

  void queueIssueAssignmentWakeup({
    heartbeat,
    issue,
    reason: "webhook_lever_event",
    mutation: "create",
    contextSource: "webhook.lever-events",
    requestedByActorType: "system",
    requestedByActorId: "webhook:lever-events",
  });

  logger.info(
    { issueId: issue.id, agentId: event.assigneeAgentId, event_type: event.event_type },
    "Issue criada via webhook lever-event",
  );

  return {
    status: 201,
    body: {
      ok: true,
      event_type: event.event_type,
      issueId: issue.id,
      identifier: issue.identifier,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
    },
  };
}

async function handleDemandCreated(
  event: z.infer<typeof demandCreatedSchema>,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  const enrichedDescription = buildEnrichedDescription(
    `**Demanda do cliente:** ${event.title}\n${event.description ?? ""}\n**area:** ${event.area ?? "não informada"}\n**demand_id:** ${event.demand_id}\n**client_id:** ${event.client_id}`,
    event.source_agent,
    event.metadata,
  );
  const issue = await ctx.svc.create(event.companyId, {
    title: `[Demanda] ${event.title}`,
    description: enrichedDescription,
    priority: event.priority,
    status: "todo",
    assigneeAgentId: event.assigneeAgentId,
  });
  await logActivity(ctx.db, {
    companyId: event.companyId,
    actorType: "system",
    actorId: "webhook:lever-events",
    agentId: null,
    runId: null,
    action: "demand.created",
    entityType: "issue",
    entityId: issue.id,
    details: {
      demand_id: event.demand_id,
      client_id: event.client_id,
      area: event.area ?? null,
      event_type: event.event_type,
    },
  });
  void queueIssueAssignmentWakeup({
    heartbeat: ctx.heartbeat,
    issue,
    reason: "webhook_lever_event",
    mutation: "create",
    contextSource: "webhook.lever-events",
    requestedByActorType: "system",
    requestedByActorId: "webhook:lever-events",
  });
  return {
    status: 201,
    body: { ok: true, event_type: event.event_type, issueId: issue.id, identifier: issue.identifier },
  };
}

async function handleBriefingCompleted(
  event: z.infer<typeof briefingCompletedSchema>,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  const enrichedDescription = buildEnrichedDescription(
    `**Briefing completado para:** ${event.client_name}\n**briefing_id:** ${event.briefing_id}\n**client_id:** ${event.client_id}\n${event.ai_summary ? `\n**Resumo IA:**\n${event.ai_summary}` : ""}`,
    event.source_agent,
    event.metadata,
  );
  const issue = await ctx.svc.create(event.companyId, {
    title: `[Briefing] Revisar estratégia — ${event.client_name}`,
    description: enrichedDescription,
    priority: "high",
    status: "todo",
    assigneeAgentId: event.assigneeAgentId,
  });
  await logActivity(ctx.db, {
    companyId: event.companyId,
    actorType: "system",
    actorId: "webhook:lever-events",
    agentId: null,
    runId: null,
    action: "briefing.completed",
    entityType: "issue",
    entityId: issue.id,
    details: {
      briefing_id: event.briefing_id,
      client_id: event.client_id,
      client_name: event.client_name,
      event_type: event.event_type,
    },
  });
  void queueIssueAssignmentWakeup({
    heartbeat: ctx.heartbeat,
    issue,
    reason: "webhook_lever_event",
    mutation: "create",
    contextSource: "webhook.lever-events",
    requestedByActorType: "system",
    requestedByActorId: "webhook:lever-events",
  });
  return {
    status: 201,
    body: { ok: true, event_type: event.event_type, issueId: issue.id, identifier: issue.identifier },
  };
}

async function handleClientCreated(
  event: z.infer<typeof clientCreatedSchema>,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  await logActivity(ctx.db, {
    companyId: event.companyId,
    actorType: "system",
    actorId: "webhook:lever-events",
    agentId: null,
    runId: null,
    action: "client.created",
    entityType: "external",
    entityId: event.client_id,
    details: {
      client_id: event.client_id,
      client_name: event.client_name,
      client_type: event.client_type ?? null,
      source_agent: event.source_agent ?? null,
      metadata: event.metadata ?? null,
      event_type: event.event_type,
    },
  });
  return {
    status: 202,
    body: { ok: true, event_type: event.event_type, recorded: "activity_log_only" },
  };
}

async function handleOnboardingPhaseAdvanced(
  event: z.infer<typeof onboardingPhaseAdvancedSchema>,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  await logActivity(ctx.db, {
    companyId: event.companyId,
    actorType: "system",
    actorId: "webhook:lever-events",
    agentId: null,
    runId: null,
    action: "onboarding.phase.advanced",
    entityType: "external",
    entityId: event.onboarding_id,
    details: {
      onboarding_id: event.onboarding_id,
      client_id: event.client_id,
      from_phase: event.from_phase ?? null,
      to_phase: event.to_phase,
      event_type: event.event_type,
    },
  });
  return {
    status: 202,
    body: { ok: true, event_type: event.event_type, recorded: "activity_log_only" },
  };
}

async function handleLeadConverted(
  event: z.infer<typeof leadConvertedSchema>,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  await logActivity(ctx.db, {
    companyId: event.companyId,
    actorType: "system",
    actorId: "webhook:lever-events",
    agentId: null,
    runId: null,
    action: "lead.converted",
    entityType: "external",
    entityId: event.lead_id,
    details: {
      lead_id: event.lead_id,
      client_id: event.client_id,
      lead_name: event.lead_name,
      event_type: event.event_type,
    },
  });
  return {
    status: 202,
    body: { ok: true, event_type: event.event_type, recorded: "activity_log_only" },
  };
}
