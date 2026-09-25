/** Comandos do gestor: proposta persistida, confirmação fora do modelo e execução única. */
import { randomInt, randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { dataYmdValida } from "@/lib/agenda/google/tempo";
import { logger } from "@/lib/logger";
import { managementActionCodeHash } from "@/lib/management/action-code";
import { reportManagementActionProblem } from "@/lib/management/failure";
import { getToolByName } from "@/lib/mcp/tools";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import type { Tarefa } from "@/lib/tarefas/tipos";
import type { createAdminClient } from "@/lib/supabase/admin";
import type pg from "pg";

type Admin = ReturnType<typeof createAdminClient>;
type ActionKind = "move_lead_stage" | "create_task" | "book_appointment" | "request_appointment" | "assign_conversation"
  | "pause_attendance" | "resume_attendance";
type ProposalInput = {
  organizationId: string; channelSessionId: string; managerUserId: string; messageId: string;
};

const proposalShape = z.object({
  action: z.enum(["move_lead_stage", "create_task", "book_appointment", "request_appointment", "assign_conversation",
    "pause_attendance", "resume_attendance"]),
  lead_id: z.string().uuid().optional(),
  to_stage_id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(255).optional(),
  due_at: z.string().datetime({ offset: true }).optional(),
  contact_id: z.string().uuid().optional(),
  requested_at: z.string().datetime({ offset: true }).optional(),
  event_type_slug: z.string().trim().min(1).optional(),
  starts_at: z.string().datetime({ offset: true }).optional(),
  owner_user_id: z.string().uuid().optional(),
  customer_agreed: z.boolean().optional(),
  conversation_id: z.string().uuid().optional(),
  to_user_id: z.string().uuid().nullable().optional(),
});
type Proposal = z.infer<typeof proposalShape>;

interface StoredAction {
  id: string; organization_id: string; channel_session_id: string; manager_user_id: string;
  action: ActionKind; payload: Record<string, unknown>; status: string;
  attempts: number; expires_at: string; code_hash: string; result_body: string | null;
}

async function activeMember(admin: Admin, input: ProposalInput | {
  organizationId: string; managerUserId: string;
}): Promise<boolean> {
  const member = await admin.from("user_organizations").select("id")
    .eq("organization_id", input.organizationId).eq("user_id", input.managerUserId)
    .in("role", ["manager", "admin"]).is("revoked_at", null)
    .not("accepted_at", "is", null).maybeSingle();
  if (member.error) throw new Error("management_action_membership_unavailable");
  return !!member.data;
}

async function preparePayload(admin: Admin, input: ProposalInput, proposal: Proposal):
  Promise<{ payload: Record<string, unknown>; preview: string }> {
  if (proposal.action === "move_lead_stage") {
    if (!proposal.lead_id || !proposal.to_stage_id) throw new Error("Informe o negócio e a etapa de destino.");
    const lead = await admin.from("crm_leads").select("id, title, pipeline_id, stage_id, status")
      .eq("organization_id", input.organizationId).eq("id", proposal.lead_id).maybeSingle();
    const target = await admin.from("crm_stages").select("id, name, pipeline_id, is_archived")
      .eq("organization_id", input.organizationId).eq("id", proposal.to_stage_id).maybeSingle();
    if (lead.error || target.error) throw new Error("Não consegui validar o negócio ou a etapa.");
    if (!lead.data || !target.data || lead.data.pipeline_id !== target.data.pipeline_id
      || target.data.is_archived || lead.data.status !== "open" || lead.data.stage_id === target.data.id)
      throw new Error("Negócio e etapa precisam estar ativos no mesmo funil, em etapas diferentes.");
    const current = await admin.from("crm_stages").select("name").eq("organization_id", input.organizationId)
      .eq("id", lead.data.stage_id).maybeSingle();
    if (current.error || !current.data) throw new Error("Não consegui validar a etapa atual.");
    return { payload: { lead_id: lead.data.id, from_stage_id: lead.data.stage_id,
      to_stage_id: target.data.id }, preview: `Mover "${lead.data.title}" de "${current.data.name}" para "${target.data.name}"` };
  }
  if (proposal.action === "create_task") {
    if (!proposal.title || !proposal.due_at || Date.parse(proposal.due_at) <= Date.now())
      throw new Error("Informe o título e um prazo futuro para a tarefa.");
    if (proposal.lead_id) {
      const lead = await admin.from("crm_leads").select("id").eq("organization_id", input.organizationId)
        .eq("id", proposal.lead_id).maybeSingle();
      if (lead.error || !lead.data) throw new Error("Negócio da tarefa não encontrado nesta empresa.");
    }
    return { payload: { title: proposal.title, due_at: proposal.due_at,
      lead_id: proposal.lead_id ?? null, assigned_to: input.managerUserId },
      preview: `Criar tarefa "${proposal.title}" para o gestor, com prazo ${proposal.due_at}` };
  }
  if (proposal.action === "book_appointment") {
    if (!proposal.contact_id || !proposal.event_type_slug || !proposal.starts_at || !proposal.customer_agreed)
      throw new Error("Para reservar, informe cliente, tipo, horário e que o cliente já concordou.");
    if (!dataYmdValida(proposal.starts_at.slice(0, 10)) || Date.parse(proposal.starts_at) <= Date.now())
      throw new Error("O horário combinado precisa ser uma data válida no futuro.");
    const [contact, eventType] = await Promise.all([
      admin.from("contacts").select("id, display_name")
        .eq("organization_id", input.organizationId).eq("id", proposal.contact_id).maybeSingle(),
      admin.from("calendar_event_types").select("id, name, is_active, default_owner_user_id")
        .eq("organization_id", input.organizationId).eq("slug", proposal.event_type_slug).maybeSingle(),
    ]);
    if (contact.error || !contact.data) throw new Error("Cliente não encontrado nesta empresa.");
    if (eventType.error || !eventType.data?.is_active) throw new Error("Tipo de atendimento indisponível nesta empresa.");
    if (!proposal.owner_user_id && !eventType.data.default_owner_user_id)
      throw new Error("O tipo de atendimento precisa de um responsável pela agenda.");
    return { payload: { contact_id: proposal.contact_id, event_type_slug: proposal.event_type_slug,
      starts_at: proposal.starts_at, owner_user_id: proposal.owner_user_id ?? eventType.data.default_owner_user_id,
      event_type_id: eventType.data.id },
      preview: `Reservar ${eventType.data.name} para ${contact.data.display_name ?? "este cliente"} em ${proposal.starts_at}. A agenda verificará a disponibilidade ao confirmar` };
  }
  if (proposal.action === "request_appointment") {
    if (!proposal.contact_id || !proposal.requested_at || !proposal.title)
      throw new Error("Informe cliente, tipo de atendimento e horário desejado.");
    if (Date.parse(proposal.requested_at) <= Date.now())
      throw new Error("O horário desejado precisa estar no futuro.");
    const contact = await admin.from("contacts").select("id, display_name")
      .eq("organization_id", input.organizationId).eq("id", proposal.contact_id).maybeSingle();
    if (contact.error || !contact.data) throw new Error("Cliente não encontrado nesta empresa.");
    return { payload: { contact_id: contact.data.id, title: proposal.title,
      requested_at: proposal.requested_at, assigned_to: input.managerUserId },
      preview: `Pedir à equipe confirmação de "${proposal.title}" para ${contact.data.display_name ?? "este cliente"} em ${proposal.requested_at}. Isto ainda não reserva a agenda` };
  }
  if (proposal.action === "pause_attendance" || proposal.action === "resume_attendance") {
    if (!proposal.conversation_id) throw new Error("Informe qual conversa deve mudar de modo.");
    const conversation = await admin.from("conversations")
      .select("id, status, bot_silenced_until, assigned_to_user_id")
      .eq("organization_id", input.organizationId).eq("id", proposal.conversation_id).maybeSingle();
    if (conversation.error || !conversation.data) throw new Error("Conversa não encontrada nesta empresa.");
    return { payload: { conversation_id: conversation.data.id,
      from_user_id: conversation.data.assigned_to_user_id ?? null,
      from_status: conversation.data.status },
      preview: proposal.action === "pause_attendance"
        ? `Pausar a IA da conversa ${conversation.data.id} e encaminhar para atendimento humano`
        : `Devolver a conversa ${conversation.data.id} à IA` };
  }
  if (!proposal.conversation_id || proposal.to_user_id === undefined)
    throw new Error("Informe a conversa e o atendente; para devolver à fila, use destino vazio.");
  const conversation = await admin.from("conversations").select("id, assigned_to_user_id")
    .eq("organization_id", input.organizationId).eq("id", proposal.conversation_id).maybeSingle();
  if (conversation.error || !conversation.data) throw new Error("Conversa não encontrada nesta empresa.");
  if (proposal.to_user_id) {
    const assignee = await admin.from("user_organizations").select("id")
      .eq("organization_id", input.organizationId).eq("user_id", proposal.to_user_id)
      .in("role", ["agent", "manager", "admin"]).is("revoked_at", null)
      .not("accepted_at", "is", null).maybeSingle();
    if (assignee.error || !assignee.data) throw new Error("Atendente não está ativo nesta empresa.");
  }
  return { payload: { conversation_id: conversation.data.id,
    from_user_id: conversation.data.assigned_to_user_id ?? null, to_user_id: proposal.to_user_id },
    preview: proposal.to_user_id
      ? `Transferir a conversa ${conversation.data.id} para o usuário ${proposal.to_user_id}`
      : `Devolver a conversa ${conversation.data.id} à fila` };
}

export function managementProposalTool(admin: Admin, input: ProposalInput) {
  let preparedReply: string | null = null;
  let preparationStarted = false;
  return {
    get reply() { return preparedReply; },
    definition: tool({
      description: "Prepare UMA alteração solicitada explicitamente pelo gestor. Não executa nada. " +
        "Use os IDs devolvidos pelas ferramentas de leitura, nunca invente IDs. " +
        "Use book_appointment só se o cliente já concordou com o horário; a reserva exige contato, tipo da lista e horário exato. " +
        "Se ainda falta acordo ou dado, request_appointment cria apenas tarefa para a equipe. " +
        "Atendimento pode ser transferido, devolvido à fila, pausado para humano ou retomado pela IA.",
      inputSchema: proposalShape,
      execute: async (raw) => {
        try {
        if (preparationStarted) return { prepared: !!preparedReply, message: "Esta mensagem já tem uma proposta em processamento." };
        preparationStarted = true;
        const proposal = proposalShape.parse(raw);
        if (!await activeMember(admin, input)) throw new Error("Gestor perdeu acesso.");
        const binding = await admin.from("management_bindings" as never).select("enabled, verified_at, actions_enabled, manager_user_id")
          .eq("organization_id", input.organizationId).eq("channel_session_id", input.channelSessionId).maybeSingle();
        const b = binding.data as { enabled: boolean; verified_at: string | null;
          actions_enabled: boolean; manager_user_id: string } | null;
        if (binding.error || !b?.enabled || !b.verified_at || !b.actions_enabled
          || b.manager_user_id !== input.managerUserId) throw new Error("Comandos não habilitados para este gestor.");
        const { payload, preview } = await preparePayload(admin, input, proposal);
        const cancelled = await admin.from("management_actions" as never)
          .update({ status: "cancelled", error_code: "superseded" } as never)
          .eq("organization_id", input.organizationId).eq("channel_session_id", input.channelSessionId)
          .eq("manager_user_id", input.managerUserId).eq("status", "pending")
          .neq("source_message_id", input.messageId);
        if (cancelled.error) throw new Error("Não consegui substituir a solicitação anterior.");
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        let code = "";
        let actionId: string | undefined;
        for (let attempt = 0; attempt < 5 && !actionId; attempt++) {
          const candidate = randomInt(0, 1_000_000).toString().padStart(6, "0");
          const codeHash = managementActionCodeHash(input, candidate);
          const { data: created, error } = await admin.from("management_actions" as never).insert({
            organization_id: input.organizationId, channel_session_id: input.channelSessionId,
            manager_user_id: input.managerUserId, source_message_id: input.messageId,
            action: proposal.action, payload, code_hash: codeHash, expires_at: expiresAt,
          } as never).select("id").single();
          if (!error) {
            actionId = (created as { id?: string } | null)?.id;
          } else if (error.code === "23505") {
            // O conflito pode ser no source_message_id ou num código já usado.
            const updated = await admin.from("management_actions" as never).update({
              action: proposal.action, payload, code_hash: codeHash,
              attempts: 0, expires_at: expiresAt,
            } as never).eq("organization_id", input.organizationId)
              .eq("source_message_id", input.messageId).eq("status", "pending")
              .select("id").maybeSingle();
            if (updated.error && updated.error.code !== "23505")
              throw new Error("Não consegui atualizar a solicitação.");
            actionId = (updated.data as { id?: string } | null)?.id;
          } else throw new Error("Não consegui guardar a solicitação.");
          if (actionId) code = candidate;
        }
        if (!actionId) throw new Error("Não consegui gerar um código exclusivo. Envie o pedido novamente.");
        await audit({ action: "management.action_proposed", actorUserId: input.managerUserId,
          organizationId: input.organizationId, resourceType: "management_action",
          resourceId: actionId, metadata: { action: proposal.action } });
        preparedReply = `${preview}. Para executar, responda CONFIRMAR ${code} em até 10 minutos. Se não confirmar, nada será alterado.`;
        return { prepared: true, message: "A proposta foi guardada; a confirmação será enviada pelo sistema." };
        } catch (error) {
          preparationStarted = false;
          return { message: error instanceof Error ? error.message : "Não consegui preparar a ação." };
        }
      },
    }),
  };
}

async function executeAction(admin: Admin, action: StoredAction): Promise<string> {
  const payload = action.payload;
  const ctx = { organizationId: action.organization_id, role: "manager" as const,
    actor: { type: "user" as const, id: action.manager_user_id, role: "manager" as const },
    apiTokenId: "", delegatedUserId: action.manager_user_id, requestId: randomUUID(), supabase: admin };
  if (action.action === "move_lead_stage") {
    const leadId = String(payload.lead_id);
    const lead = await admin.from("crm_leads").select("stage_id").eq("organization_id", action.organization_id)
      .eq("id", leadId).maybeSingle();
    if (lead.error) throw new Error("management_action_lead_unavailable");
    if (!lead.data || lead.data.stage_id !== payload.from_stage_id)
      throw new ActionRefusedError("lead_changed", "A etapa do negócio mudou. Envie um pedido novo.");
    const def = getToolByName("crm_move_lead_stage");
    if (!def) throw new Error("Ferramenta de funil indisponível.");
    await def.handler({ lead_id: leadId, to_stage_id: String(payload.to_stage_id) }, ctx);
    return "Negócio movido para a etapa solicitada.";
  }
  if (action.action === "book_appointment") {
    const eventType = await admin.from("calendar_event_types").select("id, is_active")
      .eq("organization_id", action.organization_id).eq("slug", String(payload.event_type_slug)).maybeSingle();
    if (eventType.error) throw new Error("management_action_event_type_unavailable");
    if (!eventType.data || !eventType.data.is_active
      || eventType.data.id !== payload.event_type_id)
      throw new ActionRefusedError("tipo_alterado");
    if (typeof payload.owner_user_id !== "string")
      throw new ActionRefusedError("owner_not_confirmed");
    const def = getToolByName("crm_book_appointment");
    if (!def) throw new Error("Ferramenta de agenda indisponível.");
    const result = await def.handler({ contact_id: String(payload.contact_id),
      event_type_slug: String(payload.event_type_slug), starts_at: String(payload.starts_at),
      ...(payload.owner_user_id ? { owner_user_id: String(payload.owner_user_id) } : {}),
    }, ctx) as { marcado?: boolean; motivo?: string; compromisso?: { id?: string; status?: string } };
    if (!result.marcado) {
      if (!result.motivo || result.motivo === "internal_error") throw new Error("management_booking_result_uncertain");
      throw new ActionRefusedError(result.motivo);
    }
    const appointmentId = result.compromisso?.id;
    if (!appointmentId) throw new Error("A reserva não retornou identificador persistido.");
    const saved = await admin.from("calendar_appointments").select("id, status")
      .eq("organization_id", action.organization_id).eq("id", appointmentId)
      .eq("owner_user_id", payload.owner_user_id).eq("event_type_id", String(payload.event_type_id))
      .eq("starts_at", String(payload.starts_at))
      .eq("contact_id", String(payload.contact_id)).maybeSingle();
    if (saved.error || !saved.data || !["pending", "confirmed"].includes(saved.data.status))
      throw new Error("A reserva não foi confirmada por leitura posterior.");
    return saved.data.status === "pending"
      ? "Horário reservado na agenda, aguardando confirmação do cliente conforme o tipo de atendimento."
      : "Agendamento registrado e confirmado na agenda.";
  }
  if (action.action === "assign_conversation") {
    const conversationId = String(payload.conversation_id);
    const conversation = await admin.from("conversations").select("assigned_to_user_id")
      .eq("organization_id", action.organization_id).eq("id", conversationId).maybeSingle();
    if (conversation.error) throw new Error("management_action_conversation_unavailable");
    if (!conversation.data
      || (conversation.data.assigned_to_user_id ?? null) !== payload.from_user_id)
      throw new ActionRefusedError("conversation_changed", "O responsável da conversa mudou. Envie um pedido novo.");
    const def = getToolByName("crm_assign_conversation");
    if (!def) throw new Error("Ferramenta de atendimento indisponível.");
    await def.handler({ conversation_id: conversationId, to_user_id: payload.to_user_id ?? null,
      reason: payload.to_user_id ? "transfer" : "release" }, ctx);
    return payload.to_user_id ? "Conversa transferida." : "Conversa devolvida à fila.";
  }
  if (action.action === "pause_attendance" || action.action === "resume_attendance") {
    const conversationId = String(payload.conversation_id);
    const conversation = await admin.from("conversations").select("status, assigned_to_user_id")
      .eq("organization_id", action.organization_id).eq("id", conversationId).maybeSingle();
    if (conversation.error) throw new Error("management_action_conversation_unavailable");
    if (!conversation.data || conversation.data.status !== payload.from_status
      || (conversation.data.assigned_to_user_id ?? null) !== payload.from_user_id)
      throw new ActionRefusedError("conversation_changed", "O atendimento mudou. Envie um pedido novo.");
    const def = getToolByName(action.action === "pause_attendance"
      ? "crm_request_human_handoff" : "crm_resume_ai_attendance");
    if (!def) throw new Error("Ferramenta de atendimento indisponível.");
    const result = await def.handler(action.action === "pause_attendance"
      ? { conversation_id: conversationId, reason: "manager_requested", urgency: "normal" }
      : { conversation_id: conversationId }, ctx);
    if (action.action === "pause_attendance") {
      const handoff = result as { handoff_recorded?: boolean; idempotent?: boolean };
      if (!handoff.handoff_recorded && !handoff.idempotent)
        throw new Error("A passagem para humano não foi confirmada.");
    } else if (!(result as { resumed?: boolean }).resumed) {
      throw new Error("A retomada da IA não foi confirmada.");
    }
    return action.action === "pause_attendance"
      ? "Atendimento encaminhado para humano; a IA foi pausada nesta conversa."
      : "Atendimento devolvido à IA.";
  }
  const taskId = action.id; // chave estável: uma ação nunca cria duas tarefas.
  const deadline = action.action === "request_appointment" ? payload.requested_at : payload.due_at;
  if (!Number.isFinite(Date.parse(String(deadline))) || Date.parse(String(deadline)) <= Date.now())
    throw new ActionRefusedError("deadline_elapsed", "O prazo solicitado já passou. Envie o pedido com um horário futuro.");
  const title = action.action === "request_appointment"
    ? `Confirmar agendamento: ${String(payload.title)}` : String(payload.title);
  const { data, error } = await admin.from("crm_tasks").insert({
    id: taskId, organization_id: action.organization_id, title,
    due_date: action.action === "request_appointment" ? new Date().toISOString() : String(payload.due_at),
    description: action.action === "request_appointment"
      ? `Horário solicitado: ${String(payload.requested_at)}. Verifique a disponibilidade e confirme com o cliente.` : null,
    priority: "medium", status: "pending", lead_id: payload.lead_id ?? null,
    contact_id: payload.contact_id ?? null, assigned_to: action.manager_user_id,
    created_by: action.manager_user_id,
  }).select("*").single();
  if (error || !data) throw new Error("Não foi possível registrar a tarefa.");
  await audit({ action: "crm_task.created", actorUserId: action.manager_user_id,
    organizationId: action.organization_id, resourceType: "crm_tasks", resourceId: taskId,
    metadata: { via: "management_whatsapp" } });
  await registraAtividadeDaTarefa(admin, { organizationId: action.organization_id,
    tarefa: data as Tarefa, tipo: "task_created", actorUserId: action.manager_user_id });
  return action.action === "request_appointment"
    ? "Solicitação de agendamento criada para a equipe. Ainda não há compromisso reservado na agenda."
    : "Tarefa criada para o gestor.";
}

export async function confirmManagementAction(admin: Admin, input: {
  organizationId: string; channelSessionId: string; managerUserId: string; hash: string;
}): Promise<string> {
  const binding = await admin.from("management_bindings" as never).select("enabled, verified_at, actions_enabled, manager_user_id")
    .eq("organization_id", input.organizationId).eq("channel_session_id", input.channelSessionId).maybeSingle();
  const b = binding.data as { enabled: boolean; verified_at: string | null;
    actions_enabled: boolean; manager_user_id: string } | null;
  if (binding.error || !b?.enabled || !b.verified_at || !b.actions_enabled
    || b.manager_user_id !== input.managerUserId || !await activeMember(admin, input))
    return "Comando cancelado: o acesso ou a configuração do gestor mudou.";
  const matching = await admin.from("management_actions" as never).select("*")
    .eq("organization_id", input.organizationId).eq("channel_session_id", input.channelSessionId)
    .eq("manager_user_id", input.managerUserId).eq("code_hash", input.hash.slice("confirm:".length)).maybeSingle();
  if (matching.error) throw new Error("management_action_lookup_unavailable");
  let action = matching.data as StoredAction | null;
  if (action?.status === "completed" || action?.status === "failed")
    return action.result_body ?? "Esta ação já foi processada. Confira o histórico no CRM.";
  if (action?.status === "executing" || action?.status === "uncertain")
    return "Resultado da ação ainda não confirmado. Confira o CRM antes de repetir.";
  if (action?.status === "cancelled") return "Este comando foi cancelado. Envie um pedido novo.";
  if (!action) {
    const pending = await admin.from("management_actions" as never).select("*")
      .eq("organization_id", input.organizationId).eq("channel_session_id", input.channelSessionId)
      .eq("manager_user_id", input.managerUserId).eq("status", "pending")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (pending.error) throw new Error("management_action_lookup_unavailable");
    action = pending.data as StoredAction | null;
  }
  if (!action) return "Não há comando pendente. Envie um pedido novo.";
  if (Date.parse(action.expires_at) <= Date.now()) {
    const cancelled = await admin.from("management_actions" as never)
      .update({ status: "cancelled", error_code: "expired" } as never)
      .eq("organization_id", input.organizationId).eq("id", action.id).eq("status", "pending")
      .select("id").maybeSingle();
    if (cancelled.error || !cancelled.data) throw new Error("management_action_expiry_unavailable");
    return "A confirmação expirou. Envie o pedido novamente.";
  }
  if (action.code_hash !== input.hash.slice("confirm:".length)) {
    const attempts = action.attempts + 1;
    const counted = await admin.from("management_actions" as never).update({ attempts,
      ...(attempts >= 5 ? { status: "cancelled", error_code: "too_many_attempts" } : {}) } as never)
      .eq("organization_id", input.organizationId).eq("id", action.id)
      .eq("status", "pending").eq("attempts", action.attempts).select("id").maybeSingle();
    if (counted.error || !counted.data) throw new Error("management_action_attempt_unavailable");
    return attempts >= 5 ? "Comando cancelado após cinco tentativas." : "Código incorreto. Confira a mensagem de confirmação.";
  }
  const claimed = await admin.from("management_actions" as never)
    .update({ status: "executing" } as never)
    .eq("organization_id", input.organizationId).eq("id", action.id)
    .eq("status", "pending").eq("code_hash", action.code_hash).select("id").maybeSingle();
  if (claimed.error || !claimed.data) return "Este comando já está sendo processado. Confira o histórico antes de repetir.";
  try {
    const result = await executeAction(admin, action);
    const saved = await admin.from("management_actions" as never)
      .update({ status: "completed", result_body: result } as never).eq("organization_id", input.organizationId)
      .eq("id", action.id).eq("status", "executing").select("id").maybeSingle();
    if (saved.error || !saved.data) throw new Error("action_result_unavailable");
    await audit({ action: "management.action_completed", actorUserId: input.managerUserId,
      organizationId: input.organizationId, resourceType: "management_action",
      resourceId: action.id, metadata: { action: action.action } });
    return result;
  } catch (error) {
    if (error instanceof ActionRefusedError) {
      const saved = await admin.from("management_actions" as never)
        .update({ status: "failed", error_code: error.reason, result_body: error.message } as never)
        .eq("organization_id", input.organizationId).eq("id", action.id).eq("status", "executing")
        .select("id").maybeSingle();
      if (saved.error || !saved.data) throw new Error("management_action_refusal_unavailable");
      return error.message;
    }
    logger.error("[management] resultado do comando incerto", {
      organization_id: input.organizationId, action_id: action.id, action: action.action,
    });
    await admin.from("management_actions" as never).update({ status: "uncertain", error_code: "execution_uncertain" } as never)
      .eq("organization_id", input.organizationId).eq("id", action.id).eq("status", "executing");
    await reportManagementActionProblem(admin, { organizationId: input.organizationId, actionId: action.id });
    return "Não consegui confirmar o resultado da ação. Confira o CRM antes de enviar outro pedido.";
  }
}

class ActionRefusedError extends Error {
  constructor(readonly reason: string, message = "O agendamento não foi feito. Confira o tipo e a disponibilidade antes de enviar outro pedido.") {
    super(message);
  }
}

/** Execução interrompida nunca volta a rodar sozinha: o resultado pode ter sido aplicado. */
export async function recoverUncertainManagementActions(admin: Admin, pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ id: string; organization_id: string }>(`
    update public.management_actions
       set status = 'uncertain', error_code = 'execution_interrupted'
     where status = 'executing' and updated_at < now() - interval '5 minutes'
    returning id, organization_id
  `);
  for (const row of rows) {
    await reportManagementActionProblem(admin, { organizationId: row.organization_id, actionId: row.id });
  }
  return rows.length;
}
