import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Só códigos controlados pelo módulo; nunca mensagens de banco/modelo com dados. */
export function managementFailureCode(error: unknown, stage: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^management_[a-z_]+(?::(?:[A-Z0-9]{5}|unknown))?$/.test(message)
    ? message : `${stage}_failed`;
}

/** Uma resposta normal persistida encerra o aviso de uma tentativa anterior. */
export async function resolveManagementProcessingProblem(admin: Admin, organizationId: string, messageId: string): Promise<void> {
  try {
    const { error } = await admin.from("agent_inbox_items")
      .update({ status: "resolved" }).eq("organization_id", organizationId)
      .eq("ref_kind", "management_message").eq("ref_id", messageId)
      .in("status", ["open", "ack"]);
    if (error) throw error;
  } catch {
    logger.warn("[management] aviso de processamento não pôde ser encerrado", {
      organization_id: organizationId, message_id: messageId,
    });
  }
}

/** Próximo passo visível quando o WhatsApp não confirmou a saída. */
export async function reportManagementDeliveryProblem(admin: Admin, input: {
  organizationId: string; outboxId: string; uncertain: boolean;
}): Promise<void> {
  const prior = await admin.from("agent_inbox_items").select("id")
    .eq("organization_id", input.organizationId).eq("ref_kind", "management_outbox")
    .eq("ref_id", input.outboxId).eq("status", "open").limit(1);
  if (!prior.error && (prior.data ?? []).length) return;
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: input.organizationId, kind: "other", severity: "warn",
    title: "Assistente de gestão: revisar envio ao gestor",
    body: input.uncertain
      ? "O transporte foi chamado, mas o resultado não foi confirmado. Verifique o WhatsApp comercial e o histórico do Assistente antes de qualquer nova tentativa."
      : "A mensagem não foi enviada. Abra o histórico do Assistente de gestão, corrija a causa indicada e tente novamente pela tela.",
    ref_kind: "management_outbox", ref_id: input.outboxId,
  });
  if (error) logger.error("[management] falha não entrou na Central", {
    organization_id: input.organizationId, outbox_id: input.outboxId, code: error.code,
  });
}

/** Sem HMAC, o gestor não consegue concluir o vínculo: avisar o operador uma vez. */
export async function reportUnsignedManagerIngress(admin: Admin, organizationId: string): Promise<void> {
  const prior = await admin.from("agent_inbox_items").select("id")
    .eq("organization_id", organizationId).eq("kind", "other")
    .eq("ref_kind", "management_binding").eq("ref_id", organizationId)
    .eq("status", "open").limit(1);
  if (!prior.error && (prior.data ?? []).length) return;
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: organizationId, kind: "other", severity: "warn",
    title: "Assistente de gestão: autenticação do WhatsApp ausente",
    body: "Uma resposta do número cadastrado chegou sem assinatura verificável. Ela foi isolada. Confira a configuração HMAC do canal comercial antes de reenviar a confirmação.",
    ref_kind: "management_binding", ref_id: organizationId,
  });
  if (error) logger.error("[management] aviso de autenticação não entrou na Central", {
    organization_id: organizationId, code: error.code,
  });
}

/** Falha no processamento da pergunta antes da criação da resposta. */
export async function reportManagementProcessingProblem(admin: Admin, input: {
  organizationId: string;
  messageId: string;
  stage: "binding" | "membership" | "response" | "outbox";
  failureCode: string;
}): Promise<void> {
  const prior = await admin.from("agent_inbox_items").select("id")
    .eq("organization_id", input.organizationId).eq("ref_kind", "management_message")
    .eq("ref_id", input.messageId).in("status", ["open", "ack"]).limit(1);
  if (!prior.error && (prior.data ?? []).length) return;
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: input.organizationId, kind: "other", severity: "warn",
    title: "Assistente de gestão: pergunta sem resposta",
    body: `Uma pergunta recebida não foi processada na etapa ${input.stage} (código: ${input.failureCode}). Abra o histórico do Assistente e confira a configuração, os dados da empresa e a conexão do WhatsApp.`,
    ref_kind: "management_message", ref_id: input.messageId,
  });
  if (error) logger.error("[management] falha de processamento não entrou na Central", {
    organization_id: input.organizationId, message_id: input.messageId,
    stage: input.stage, failure_code: input.failureCode, code: error.code,
  });
}

/** Uma alteração pode ter sido aplicada antes da queda; nunca tentar novamente às cegas. */
export async function reportManagementActionProblem(admin: Admin, input: {
  organizationId: string; actionId: string;
}): Promise<void> {
  const prior = await admin.from("agent_inbox_items").select("id")
    .eq("organization_id", input.organizationId).eq("ref_kind", "management_action")
    .eq("ref_id", input.actionId).in("status", ["open", "ack"]).limit(1);
  if (!prior.error && (prior.data ?? []).length) return;
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: input.organizationId, kind: "other", severity: "warn",
    title: "Assistente de gestão: conferir comando",
    body: "O resultado de um comando pelo WhatsApp é incerto. Confira o CRM e o histórico do Assistente antes de repetir a operação.",
    ref_kind: "management_action", ref_id: input.actionId,
  });
  if (error) logger.error("[management] comando incerto não entrou na Central", {
    organization_id: input.organizationId, action_id: input.actionId, code: error.code,
  });
}
