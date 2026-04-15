/**
 * Webhook route: POST /api/webhooks/lever-events
 *
 * ── Dialética Socrática ──────────────────────────────────────────────
 *
 * 1. "Por que precisamos de um novo middleware aqui?"
 *    Tese: Criar um middleware completo de auth com JWT, rate-limiting, IP-whitelist.
 *    Antítese: V1 de uma agência de IA não tem superfície pública; o endpoint é chamado
 *    apenas por sistemas internos. Over-engineering agora gera complexidade sem retorno.
 *    Síntese: Bearer token simples via header Authorization. Verificação O(1), sem
 *    dependências externas. Escalamos para HMAC/JWT quando houver parceiros externos.
 *
 * 2. "A criação da Task impacta o event loop do orquestrador?"
 *    Tese: Usar fila (BullMQ, Redis) para desacoplar ingestão de execução.
 *    Antítese: O Paperclip já tem `queueIssueAssignmentWakeup()` que aciona o heartbeat
 *    internamente com fire-and-forget. A inserção no banco + wakeup nativo já é a fila.
 *    Síntese: Reutilizar `issueService.create()` + `queueIssueAssignmentWakeup()` e
 *    responder 201 ao caller. O heartbeat scheduler faz o polling. Zero infraestrutura extra.
 *
 * 3. "Tipagem do payload precisa ser estrita?"
 *    Tese: Schema Zod rígido para cada campo do Lever System.
 *    Antítese: O sistema externo pode evoluir o payload e quebraria a integração.
 *    Síntese: Validar apenas os campos mínimos obrigatórios (title, companyId, agentId).
 *    Campos opcionais (description, priority, metadata) são aceitos com flexibilidade.
 *    metadata vai como JSONB nativo no campo existente de description (serializado).
 * ─────────────────────────────────────────────────────────────────────
 */

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@paperclipai/shared";
import { issueService, heartbeatService, logActivity } from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

// ── Payload schema ─────────────────────────────────────────────────
// Campos mínimos: title + companyId + assigneeAgentId.
// Campos opcionais: description, priority, status, source_agent, metadata.
const leverEventSchema = z.object({
  title: z.string().min(1, "title é obrigatório"),
  description: z.string().optional().nullable(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  status: z.enum(ISSUE_STATUSES).optional().default("todo"),
  companyId: z.string().uuid("companyId deve ser UUID válido"),
  assigneeAgentId: z.string().uuid("assigneeAgentId deve ser UUID válido"),
  source_agent: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export function webhookRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);
  const heartbeat = heartbeatService(db);

  router.post("/webhooks/lever-events", async (req, res) => {
    // ── Auth: Bearer token ───────────────────────────────────────
    const expectedSecret = process.env.WEBHOOK_SECRET;
    if (!expectedSecret) {
      logger.error("WEBHOOK_SECRET não está definido no .env — endpoint desabilitado");
      res.status(503).json({ error: "Webhook endpoint not configured" });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = authHeader.slice(7);
    if (token !== expectedSecret) {
      res.status(403).json({ error: "Invalid webhook secret" });
      return;
    }

    // ── Validação do payload ─────────────────────────────────────
    const parsed = leverEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: "Invalid payload",
        details: parsed.error.issues,
      });
      return;
    }

    const { title, description, priority, status, companyId, assigneeAgentId, source_agent, metadata } = parsed.data;

    // ── Composição da description enriquecida ────────────────────
    // Inclui metadata e source_agent como contexto extra no corpo da task
    const enrichedDescription = [
      description ?? "",
      source_agent ? `\n\n---\n**Origem:** ${source_agent}` : "",
      metadata ? `\n**Metadata:** \`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`` : "",
    ]
      .join("")
      .trim() || null;

    try {
      // ── Criação da Issue (reutiliza service nativo) ────────────
      const issue = await svc.create(companyId, {
        title,
        description: enrichedDescription,
        priority,
        status,
        assigneeAgentId,
      });

      // ── Activity log ───────────────────────────────────────────
      await logActivity(db, {
        companyId,
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
          source_agent: source_agent ?? null,
        },
      });

      // ── Acorda o agente (fire-and-forget, não bloqueia response)
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
        { issueId: issue.id, agentId: assigneeAgentId, source: source_agent },
        "Webhook lever-event: issue created and agent wakeup queued",
      );

      res.status(201).json({
        ok: true,
        issueId: issue.id,
        identifier: issue.identifier,
        status: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
      });
    } catch (err) {
      logger.error({ err, payload: parsed.data }, "Webhook lever-event: failed to create issue");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
