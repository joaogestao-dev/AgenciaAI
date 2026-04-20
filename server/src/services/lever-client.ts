import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logger } from "../middleware/logger.js";

// ════════════════════════════════════════════════════════════════════
// Cliente outbound Paperclip → Lever (Edge Function paperclip-inbound)
//
// Responsabilidades:
// - Construir envelope { action, params, idempotency_key, actor }
// - Injetar Authorization (Bearer) + apikey (anon) + Content-Type
// - Gerar idempotency_key se não fornecida
// - Validar resposta com Zod (replay vs success vs erro)
// - Retry exponencial em 5xx (máx 2). Nunca em 4xx.
// - Timeout 10s. Não logar Bearer.
// ════════════════════════════════════════════════════════════════════

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

const successSchema = z.object({
  success: z.literal(true),
  action: z.string(),
  idempotency_key: z.string(),
  result: z.unknown(),
});

const replaySchema = z.object({
  replayed: z.literal(true),
  action: z.string(),
  status: z.enum(["success", "error"]),
  result: z.unknown().nullable(),
  error: z
    .object({ code: z.string(), message: z.string() })
    .nullable()
    .optional(),
  at: z.string(),
});

const errorSchema = z.object({
  success: z.literal(false),
  action: z.string(),
  idempotency_key: z.string(),
  error: z.object({ code: z.string(), message: z.string() }),
});

const responseSchema = z.union([successSchema, replaySchema, errorSchema]);

export type LeverActionResult<T> =
  | { kind: "success"; replayed: false; idempotencyKey: string; result: T }
  | { kind: "replay"; replayed: true; status: "success" | "error"; result: T | null; at: string };

export class LeverClientError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly action: string;
  constructor(message: string, code: string, httpStatus: number, action: string) {
    super(message);
    this.name = "LeverClientError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.action = action;
  }
}

type CallOptions = {
  idempotencyKey?: string;
  actor?: string;
  signal?: AbortSignal;
};

type ResolvedConfig = {
  url: string;
  bearer: string;
  anonKey: string;
  defaultActor: string;
};

let cachedConfig: ResolvedConfig | null = null;

function resolveConfig(): ResolvedConfig {
  if (cachedConfig) return cachedConfig;
  const url = process.env.LEVER_INBOUND_URL?.trim();
  const bearer = process.env.LEVER_INBOUND_BEARER?.trim();
  const anonKey = process.env.LEVER_ANON_KEY?.trim();
  const defaultActor = process.env.LEVER_DEFAULT_ACTOR?.trim() || "paperclip-orchestrator";
  if (!url || !bearer || !anonKey) {
    throw new Error(
      "Cliente Lever desabilitado: LEVER_INBOUND_URL, LEVER_INBOUND_BEARER ou LEVER_ANON_KEY ausentes no .env",
    );
  }
  cachedConfig = { url, bearer, anonKey, defaultActor };
  return cachedConfig;
}

export function isLeverClientConfigured(): boolean {
  try {
    resolveConfig();
    return true;
  } catch {
    return false;
  }
}

export async function callLeverAction<T = unknown>(
  action: string,
  params: Record<string, unknown>,
  opts: CallOptions = {},
): Promise<LeverActionResult<T>> {
  const config = resolveConfig();
  const idempotencyKey = opts.idempotencyKey?.trim() || `pc_${action}_${Date.now()}_${randomUUID()}`;
  const actor = opts.actor?.trim() || config.defaultActor;

  const envelope = { action, params, idempotency_key: idempotencyKey, actor };

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;

    try {
      const res = await fetch(config.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.bearer}`,
          apikey: config.anonKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(envelope),
        signal,
      });
      clearTimeout(timeoutId);

      const text = await res.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        if (res.status >= 500 && attempt < MAX_RETRIES) {
          lastError = new LeverClientError(
            `Resposta não-JSON do Lever (HTTP ${res.status}). Tentativa ${attempt + 1}/${MAX_RETRIES + 1}.`,
            "non_json_response",
            res.status,
            action,
          );
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new LeverClientError(
          `Resposta não-JSON do Lever: HTTP ${res.status}`,
          "non_json_response",
          res.status,
          action,
        );
      }

      if (res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          logger.warn(
            { action, attempt: attempt + 1, status: res.status, idempotencyKey },
            "Lever 5xx — tentando novamente",
          );
          await sleep(backoffMs(attempt));
          continue;
        }
        const code = (payload as { error?: { code?: string } })?.error?.code ?? "server_error";
        const msg =
          (payload as { error?: { message?: string } | string })?.error &&
          typeof (payload as { error?: unknown }).error === "object"
            ? ((payload as { error: { message: string } }).error.message)
            : `Lever respondeu ${res.status}`;
        throw new LeverClientError(msg, code, res.status, action);
      }

      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new LeverClientError(
          `Envelope de resposta inválido: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          "invalid_response_envelope",
          res.status,
          action,
        );
      }

      const data = parsed.data;
      if ("replayed" in data) {
        logger.info({ action, idempotencyKey, at: data.at }, "Lever replay");
        return {
          kind: "replay",
          replayed: true,
          status: data.status,
          result: (data.result ?? null) as T | null,
          at: data.at,
        };
      }

      if (data.success === false) {
        throw new LeverClientError(data.error.message, data.error.code, res.status, action);
      }

      logger.info({ action, idempotencyKey }, "Lever action ok");
      return {
        kind: "success",
        replayed: false,
        idempotencyKey: data.idempotency_key,
        result: data.result as T,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof LeverClientError) throw err;
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort) {
        throw new LeverClientError(
          `Timeout (${TIMEOUT_MS}ms) chamando Lever`,
          "timeout",
          0,
          action,
        );
      }
      if (attempt < MAX_RETRIES) {
        lastError = err;
        logger.warn(
          { action, attempt: attempt + 1, err: (err as Error).message },
          "Erro de rede chamando Lever — tentando novamente",
        );
        await sleep(backoffMs(attempt));
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new LeverClientError(`Falha de rede chamando Lever: ${msg}`, "network_error", 0, action);
    }
  }

  const msg = lastError instanceof Error ? lastError.message : "erro desconhecido";
  throw new LeverClientError(`Falha após ${MAX_RETRIES + 1} tentativas: ${msg}`, "exhausted_retries", 0, action);
}

function backoffMs(attempt: number): number {
  return Math.min(2000, 200 * Math.pow(2, attempt));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Helpers tipados por ação ────────────────────────────────────────

export type LeverClientSnapshot = {
  id: string;
  workspace_id: string;
  name: string;
  client_type: string | null;
  project_name: string | null;
  project_deadline: string | null;
  is_archived: boolean;
  created_at: string;
  primary_color: string | null;
  payment_due_day: number | null;
  fee_fixed: number | null;
  commission_rate: number | null;
  shopify_status: string | null;
  cartpanda_status: string | null;
  onboarding_type: string | null;
};

export async function leverListActions(opts: CallOptions = {}) {
  return await callLeverAction<{
    actions: Array<{ name: string; description: string; params_schema: unknown }>;
    count: number;
  }>("list_actions", {}, opts);
}

export async function leverGetClientSnapshot(
  filter: { client_id: string } | { name_contains: string },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    clients: LeverClientSnapshot[];
    count: number;
  }>("get_client_snapshot", filter as Record<string, unknown>, opts);
}

export async function leverCreateClientTask(
  params: {
    client_id: string;
    title: string;
    description?: string | null;
    priority?: "low" | "medium" | "high" | "critical";
    area?: "strategy" | "traffic" | "design" | "dev" | null;
    due_date?: string | null;
    checklist?: Array<{ title: string; done?: boolean }>;
    product_id?: string | null;
    product_name?: string | null;
  },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    task_id: string;
    client_id: string;
    client_name: string;
    workspace_id: string;
    status: string;
    priority: string;
    created_at: string;
    created_by: string;
  }>("create_client_task", params as Record<string, unknown>, opts);
}

export async function leverUpdateClientTaskStatus(
  params: { task_id: string; status: "pending" | "completed" },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    task: { id: string; status: string; title: string; updated_at: string; completed_at: string | null };
  }>("update_client_task_status", params as Record<string, unknown>, opts);
}

// ── Lote 3.1: leituras seguras ─────────────────────────────────────

export async function leverListClients(
  params: {
    workspace_id?: string;
    include_archived?: boolean;
    limit?: number;
    offset?: number;
  } = {},
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    clients: LeverClientSnapshot[];
    page: { offset: number; limit: number; total: number | null };
  }>("list_clients", params as Record<string, unknown>, opts);
}

export type LeverTaskRow = {
  id: string;
  client_id: string;
  workspace_id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  priority: "low" | "medium" | "high" | "critical";
  area: string | null;
  assignee_id: string | null;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  source: string | null;
  product_name: string | null;
};

export async function leverListClientTasks(
  params: {
    client_id: string;
    status?: "pending" | "in_progress" | "completed" | "blocked";
    assignee_id?: string | null;
    limit?: number;
  },
  opts: CallOptions = {},
) {
  return await callLeverAction<{ tasks: LeverTaskRow[]; count: number }>(
    "list_client_tasks",
    params as Record<string, unknown>,
    opts,
  );
}

export async function leverGetWorkspaceSummary(
  params: { workspace_id?: string } = {},
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    summary: {
      workspace_id: string;
      clients: { total: number; archived: number };
      tasks_by_status: Record<string, number>;
      leads_by_status: Record<string, number>;
      invoices: { pending: number; overdue: number; paid: number };
      team: { active_agency: number; active_clients: number };
      demand_requests_pending: number;
      onboarding: { em_andamento: number; concluido: number };
      recent_notifications: Array<{ id: string; type: string; title: string; created_at: string }>;
      generated_at: string;
    };
  }>("get_workspace_summary", params as Record<string, unknown>, opts);
}

export type LeverTeamMember = {
  id: string;
  workspace_id: string | null;
  user_id: string | null;
  name: string | null;
  email: string;
  role: string;
  user_type: "agency" | "client" | null;
  status: "pending" | "active" | "inactive";
  joined_at: string | null;
  linked_client_id: string | null;
};

export async function leverListTeamMembers(
  params: {
    workspace_id?: string;
    user_type?: "agency" | "client";
    status?: "pending" | "active" | "inactive";
    limit?: number;
  } = {},
  opts: CallOptions = {},
) {
  return await callLeverAction<{ members: LeverTeamMember[]; count: number }>(
    "list_team_members",
    params as Record<string, unknown>,
    opts,
  );
}

// ── Lote 3.2: leituras com redação ─────────────────────────────────

export type LeverLead = {
  id: string;
  workspace_id: string | null;
  name: string;
  store_name: string | null;
  phone: string | null;
  email: string | null;
  lead_status: string;
  lead_score: string | null;
  product_interest: string | null;
  observations: string | null;
  site_url: string | null;
  revenue: string | null;
  created_at: string;
};

export async function leverListLeads(
  params: {
    workspace_id?: string;
    lead_status?: "contato" | "resposta" | "follow_up" | "fechamento";
    product_interest?: string;
    limit?: number;
    offset?: number;
    redact?: boolean;
  } = {},
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    leads: LeverLead[];
    page: { offset: number; limit: number; total: number | null };
    redacted: boolean;
  }>("list_leads", params as Record<string, unknown>, opts);
}

export async function leverGetOnboardingState(
  params: { client_id: string; timeline_limit?: number },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    onboarding: Record<string, unknown> | null;
    phases: Array<Record<string, unknown> & { tasks: Array<Record<string, unknown>> }>;
    timeline: Array<Record<string, unknown>>;
  }>("get_onboarding_state", params as Record<string, unknown>, opts);
}

// ── Lote 3.3: escritas em tarefas ──────────────────────────────────

export async function leverAssignTask(
  params: { task_id: string; assignee_user_id: string | null },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    task: { id: string; title: string; assignee_id: string | null; status: string; updated_at: string };
  }>("assign_task", params as Record<string, unknown>, opts);
}

export async function leverAddTaskComment(
  params: { task_id: string; content: string },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    comment: {
      id: string;
      task_id: string;
      user_id: string;
      user_name: string;
      content: string;
      created_at: string;
    };
  }>("add_task_comment", params as Record<string, unknown>, opts);
}

export async function leverUpdateTaskFields(
  params: {
    task_id: string;
    patch: {
      priority?: "low" | "medium" | "high" | "critical";
      area?: "strategy" | "traffic" | "design" | "dev" | null;
      due_date?: string | null;
      description?: string | null;
      checklist?: Array<{ title: string; done?: boolean }>;
    };
  },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    task: Record<string, unknown>;
    applied_patch: Record<string, unknown>;
  }>("update_task_fields", params as Record<string, unknown>, opts);
}

// ── Lote 3.4: escritas em clientes e onboarding ────────────────────

export async function leverUpdateClientProfile(
  params: {
    client_id: string;
    patch: {
      project_name?: string | null;
      project_deadline?: string | null;
      primary_color?: string | null;
      payment_due_day?: number | null;
      is_archived?: boolean;
    };
  },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    client: Record<string, unknown>;
    applied_patch: Record<string, unknown>;
  }>("update_client_profile", params as Record<string, unknown>, opts);
}

export async function leverCompleteOnboardingTask(
  params: { onboarding_task_id: string; note: string },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    task: Record<string, unknown>;
    timeline_recorded?: boolean;
    message?: string;
  }>("complete_onboarding_task", params as Record<string, unknown>, opts);
}

export async function leverAdvanceOnboardingPhase(
  params: { onboarding_id: string },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    previous_phase: { key: string; name: string };
    next_phase: { key: string; name: string } | null;
    onboarding_completed: boolean;
  }>("advance_onboarding_phase", params as Record<string, unknown>, opts);
}

// ── Lote 3.5: CRM e comunicação ────────────────────────────────────

export async function leverCreateLead(
  params: {
    workspace_id: string;
    name: string;
    phone?: string | null;
    email?: string | null;
    store_name?: string | null;
    product_interest?: string | null;
    observations?: string | null;
    site_url?: string | null;
    revenue?: string | null;
    lead_status?: "contato" | "resposta" | "follow_up" | "fechamento";
  },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    lead: LeverLead;
    created: boolean;
    reason?: string;
  }>("create_lead", params as Record<string, unknown>, opts);
}

export async function leverUpdateLeadStatus(
  params: {
    lead_id: string;
    lead_status: "contato" | "resposta" | "follow_up" | "fechamento";
  },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    lead: { id: string; name: string; lead_status: string };
  }>("update_lead_status", params as Record<string, unknown>, opts);
}

export async function leverConvertLeadToClient(
  params: {
    lead_id: string;
    client_type?: string;
    assigned_products?: string[];
  },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    client_id: string;
    lead_id: string;
    created: boolean;
    workspace_id?: string;
    lead_name?: string;
    reason?: string;
  }>("convert_lead_to_client", params as Record<string, unknown>, opts);
}

export async function leverSendClientNotification(
  params: {
    user_id: string;
    workspace_id?: string;
    type?: string;
    title: string;
    message?: string | null;
    link?: string | null;
    metadata?: Record<string, unknown> | null;
  },
  opts: CallOptions = {},
) {
  return await callLeverAction<{
    notification: {
      id: string;
      user_id: string;
      workspace_id: string | null;
      type: string;
      title: string;
      created_at: string;
    };
  }>("send_client_notification", params as Record<string, unknown>, opts);
}
