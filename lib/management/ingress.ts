/** Audiência gerencial: interceptar antes de criar contato, conversa ou lead. */
import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";
import { enqueueManagementDelivery } from "@/lib/management/outbox";
import { managementConfirmationHash } from "@/lib/management/action-code";
import { reportUnsignedManagerIngress } from "@/lib/management/failure";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface ManagementBinding {
  organization_id: string;
  channel_session_id: string;
  manager_user_id: string;
  manager_name: string;
  manager_phone: string;
  enabled: boolean;
  actions_enabled: boolean;
  verified_at: string | null;
  challenge_hash: string | null;
  challenge_expires_at: string | null;
  challenge_attempts: number;
  paused_at: string | null;
  daily_enabled: boolean;
  daily_hour: number;
  weekly_enabled: boolean;
  weekly_day: number;
  weekly_hour: number;
  alerts_enabled: boolean;
  alert_categories: string[];
  max_daily_alerts: number;
}

export async function loadManagementBinding(admin: Admin, orgId: string, sessionId: string): Promise<ManagementBinding | null> {
  const { data, error } = await admin.from("management_bindings" as never)
    .select("*").eq("organization_id", orgId).eq("channel_session_id", sessionId).maybeSingle();
  if (error) throw new Error(`management_binding_read:${error.code ?? "unknown"}`);
  return data as ManagementBinding | null;
}

export function matchesManagerPhone(configured: string, incoming: string): boolean {
  const a = new Set(phoneLookupVariants(canonicalPhoneBR(configured)));
  return phoneLookupVariants(incoming).some((phone) => a.has(phone));
}

export function challengeHash(orgId: string, sessionId: string, code: string): string {
  return createHmac("sha256", env.INTERNAL_SECRET)
    .update(`${orgId}:${sessionId}:${code}`, "utf8").digest("hex");
}

function matchesChallenge(binding: ManagementBinding, code: string): boolean {
  if (!binding.challenge_hash || !/^\d{6}$/.test(code.trim())) return false;
  const expected = Buffer.from(binding.challenge_hash, "hex");
  const received = Buffer.from(challengeHash(binding.organization_id, binding.channel_session_id, code.trim()), "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export interface ManagementIngress {
  organizationId: string;
  channelSessionId: string;
  phone: string | null;
  externalId: string;
  body: string | null;
  direction: "inbound" | "outbound";
  authenticated: boolean;
}

/** true = esta audiência pertence à gestão, inclusive se a origem foi recusada. */
export async function interceptManagementMessage(admin: Admin, input: ManagementIngress): Promise<boolean> {
  if (!input.phone) return false;
  const binding = await loadManagementBinding(admin, input.organizationId, input.channelSessionId);
  if (!binding || !matchesManagerPhone(binding.manager_phone, input.phone)) return false;

  // Mesmo um gestor desativado não pode virar lead por um webhook tardio.
  if (!input.authenticated) {
    logger.warn("[management] evento do gestor sem autenticidade; isolado", {
      organization_id: input.organizationId, channel_session_id: input.channelSessionId,
    });
    await reportUnsignedManagerIngress(admin, input.organizationId);
    return true;
  }

  if (input.direction === "outbound") return true; // eco do comercial não vira atendimento manual.

  const code = (input.body ?? "").trim();
  const pauseRequest = /^(pausar avisos|silenciar avisos)$/i.test(code);
  const actionConfirmation = binding.verified_at ? managementConfirmationHash({
    organizationId: input.organizationId, channelSessionId: input.channelSessionId,
    managerUserId: binding.manager_user_id,
  }, code) : null;
  const { error: insertError } = await admin.from("management_messages" as never).insert({
    organization_id: input.organizationId,
    channel_session_id: input.channelSessionId,
    external_id: input.externalId,
    direction: "inbound",
    kind: !binding.verified_at ? "verification" : pauseRequest ? "pause" : binding.enabled ? "consultation" : "ignored",
    body: !binding.verified_at && /^\d{6}$/.test(code)
      ? "[código de confirmação recebido]"
      : actionConfirmation ?? (input.body ?? "").slice(0, 3000),
  } as never);
  if (insertError?.code === "23505") return true;
  if (insertError) throw new Error(`management_message_insert:${insertError.code ?? "unknown"}`);

  const { data: member, error: memberError } = await admin.from("user_organizations")
    .select("id").eq("organization_id", input.organizationId)
    .eq("user_id", binding.manager_user_id).in("role", ["manager", "admin"])
    .is("revoked_at", null)
    .not("accepted_at", "is", null).maybeSingle();
  if (memberError) throw new Error(`management_membership:${memberError.code ?? "unknown"}`);
  if (!member) return true;

  if (!binding.verified_at && binding.challenge_hash && binding.challenge_expires_at
      && Date.parse(binding.challenge_expires_at) > Date.now() && binding.challenge_attempts < 5) {
    if (matchesChallenge(binding, code)) {
      const { error, data } = await admin.from("management_bindings" as never)
        .update({ verified_at: new Date().toISOString(), enabled: true,
          challenge_hash: null, challenge_expires_at: null, challenge_attempts: 0 } as never)
        .eq("organization_id", input.organizationId)
        .eq("channel_session_id", input.channelSessionId)
        .eq("challenge_hash", binding.challenge_hash)
        .is("verified_at", null).select("organization_id").maybeSingle();
      if (error || !data) throw new Error(`management_verify:${error?.code ?? "stale"}`);
      await audit({ action: "management.verification_completed", actorUserId: binding.manager_user_id,
        organizationId: input.organizationId, resourceType: "management_binding",
        resourceId: input.organizationId, metadata: { channel_session_id: input.channelSessionId } });
      await enqueueManagementDelivery(admin, {
        organizationId: input.organizationId, channelSessionId: input.channelSessionId,
        kind: "consultation", dedupeKey: `verified:${input.externalId}`,
        body: "Número confirmado. Você pode consultar as informações desta empresa por aqui. Para parar os avisos automáticos, envie: pausar avisos.",
      });
    } else {
      const { error } = await admin.from("management_bindings" as never)
        .update({ challenge_attempts: binding.challenge_attempts + 1 } as never)
        .eq("organization_id", input.organizationId)
        .eq("challenge_hash", binding.challenge_hash)
        .eq("challenge_attempts", binding.challenge_attempts);
      if (error) throw new Error(`management_attempt:${error.code ?? "unknown"}`);
    }
    return true;
  }

  if (!binding.enabled || !binding.verified_at) return true;
  if (pauseRequest) {
    const { error } = await admin.from("management_bindings" as never)
      .update({ paused_at: new Date().toISOString() } as never)
      .eq("organization_id", input.organizationId)
      .eq("channel_session_id", input.channelSessionId);
    if (error) throw new Error(`management_pause:${error.code ?? "unknown"}`);
    return true;
  }

  // O cron dedicado consome mensagens ainda sem resposta. A persistência acima
  // dá idempotência mesmo quando o canal reentrega ou o processo reinicia.
  return true;
}
