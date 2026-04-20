import type { SupabaseClient } from "@supabase/supabase-js";
import { listActions } from "./actions/list-actions.ts";
import { getClientSnapshot } from "./actions/get-client-snapshot.ts";
import { createClientTask } from "./actions/create-client-task.ts";
import { updateClientTaskStatus } from "./actions/update-client-task-status.ts";
import { listClients } from "./actions/list-clients.ts";
import { listClientTasks } from "./actions/list-client-tasks.ts";
import { getWorkspaceSummary } from "./actions/get-workspace-summary.ts";
import { listTeamMembers } from "./actions/list-team-members.ts";
import { listLeads } from "./actions/list-leads.ts";
import { getOnboardingState } from "./actions/get-onboarding-state.ts";
import { assignTask } from "./actions/assign-task.ts";
import { addTaskComment } from "./actions/add-task-comment.ts";
import { updateTaskFields } from "./actions/update-task-fields.ts";
import { updateClientProfile } from "./actions/update-client-profile.ts";
import { completeOnboardingTask } from "./actions/complete-onboarding-task.ts";
import { advanceOnboardingPhase } from "./actions/advance-onboarding-phase.ts";
import { createLead } from "./actions/create-lead.ts";
import { updateLeadStatus } from "./actions/update-lead-status.ts";
import { convertLeadToClient } from "./actions/convert-lead-to-client.ts";
import { sendClientNotification } from "./actions/send-client-notification.ts";

export type ActionContext = {
  actor: string | null;
  supabase: SupabaseClient;
};

export type ActionHandler = (
  params: Record<string, unknown>,
  ctx: ActionContext,
) => Promise<unknown>;

export type ActionDef = {
  description: string;
  paramsSchema: Record<string, unknown>;
  handler: ActionHandler;
};

export const REGISTRY: Record<string, ActionDef> = {
  // Discovery
  list_actions: listActions,
  // Reads
  get_client_snapshot: getClientSnapshot,
  list_clients: listClients,
  list_client_tasks: listClientTasks,
  get_workspace_summary: getWorkspaceSummary,
  list_team_members: listTeamMembers,
  list_leads: listLeads,
  get_onboarding_state: getOnboardingState,
  // Writes — tasks
  create_client_task: createClientTask,
  update_client_task_status: updateClientTaskStatus,
  assign_task: assignTask,
  add_task_comment: addTaskComment,
  update_task_fields: updateTaskFields,
  // Writes — clients & onboarding
  update_client_profile: updateClientProfile,
  complete_onboarding_task: completeOnboardingTask,
  advance_onboarding_phase: advanceOnboardingPhase,
  // Writes — CRM
  create_lead: createLead,
  update_lead_status: updateLeadStatus,
  convert_lead_to_client: convertLeadToClient,
  // Communication
  send_client_notification: sendClientNotification,
};

export async function dispatch(
  name: string,
  params: Record<string, unknown>,
  ctx: ActionContext,
): Promise<unknown> {
  const def = REGISTRY[name];
  if (!def) {
    const e = new Error(`Acao desconhecida: ${name}. Use list_actions para o manifest.`) as Error & {
      code?: string;
      httpStatus?: number;
    };
    e.code = "unknown_action";
    e.httpStatus = 400;
    throw e;
  }
  return await def.handler(params, ctx);
}
