// paperclip-inbound: ponto unico de entrada do canal Paperclip -> Lever
// Auth: Bearer PAPERCLIP_WEBHOOK_SECRET (comparacao time-constant)
// Envelope: { action, params, idempotency_key, actor? }
// Idempotencia: paperclip_action_log.idempotency_key UNIQUE -> replay
// Auditoria: append-only em paperclip_action_log (service role only)

import { z } from "zod";
import { authenticate } from "./_shared/auth.ts";
import { getServiceClient } from "./_shared/db.ts";
import { dispatch } from "./registry.ts";

const envelopeSchema = z.object({
  action: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  idempotency_key: z.string().min(8).max(200),
  actor: z.string().min(1).max(100).optional(),
});

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Metodo nao permitido. Use POST." });

  const auth = authenticate(req);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body JSON invalido" });
  }

  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    return json(400, { error: "Envelope invalido", details: parsed.error.issues });
  }
  const { action, params, idempotency_key, actor } = parsed.data;

  let supabase;
  try {
    supabase = getServiceClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json(500, { error: `Servidor mal configurado: ${msg}` });
  }

  const { data: existing, error: lookupErr } = await supabase
    .from("paperclip_action_log")
    .select("status, result, error, action, created_at")
    .eq("idempotency_key", idempotency_key)
    .maybeSingle();
  if (lookupErr) {
    return json(500, { error: `Falha ao consultar log de idempotencia: ${lookupErr.message}` });
  }
  if (existing) {
    return json(200, {
      replayed: true,
      action: existing.action,
      status: existing.status,
      result: existing.result,
      error: existing.error,
      at: existing.created_at,
    });
  }

  try {
    const result = await dispatch(action, params, { actor: actor ?? null, supabase });
    await supabase.from("paperclip_action_log").insert({
      idempotency_key,
      action,
      actor: actor ?? null,
      params,
      status: "success",
      result,
    });
    return json(200, { success: true, action, idempotency_key, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code ?? "unknown_error";
    const httpStatus = (err as { httpStatus?: number })?.httpStatus ?? 422;
    const errorPayload = { code, message };
    await supabase.from("paperclip_action_log").insert({
      idempotency_key,
      action,
      actor: actor ?? null,
      params,
      status: "error",
      error: errorPayload,
    });
    return json(httpStatus, { success: false, action, idempotency_key, error: errorPayload });
  }
});
