import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

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
