import type pg from "pg";

import { decidePacing, dayStartInTz } from "@/lib/agent-engine/pacing/engine";
import { loadChannelKnobs, loadPacingState, recordSend } from "@/lib/agent-engine/pacing/store";
import { capabilitiesOf, CHANNEL_SESSION_REF_COLUMNS, getAdapter, resolveSessionRef,
  type ChannelProvider, type ChannelSessionRef } from "@/lib/channels";
import { logger } from "@/lib/logger";
import { reportManagementDeliveryProblem } from "@/lib/management/failure";
import { openVerificationBody } from "@/lib/management/challenge-envelope";
import { managementActionCodeHash } from "@/lib/management/action-code";
import { loadManagementBinding } from "@/lib/management/ingress";
import { managementSnapshot } from "@/lib/management/report";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

interface OutboxRow {
  id: string; organization_id: string; channel_session_id: string; dedupe_key: string;
  body_encrypted: boolean;
  kind: "verification" | "consultation" | "daily" | "weekly" | "alert";
  body: string; verification_hash: string | null;
  alert_source: string | null; reference_id: string | null;
}

async function claim(pool: pg.Pool): Promise<OutboxRow | null> {
  const { rows } = await pool.query<OutboxRow>(`
    with picked as (
      select id from public.management_outbox
      where status = 'pending' and next_attempt_at <= now()
      order by created_at for update skip locked limit 1
    )
    update public.management_outbox o
       set status = 'sending', attempt_count = attempt_count + 1,
           lease_until = now() + interval '3 minutes'
      from picked where o.id = picked.id
    returning o.id, o.organization_id, o.channel_session_id, o.dedupe_key, o.kind, o.body, o.body_encrypted,
              o.verification_hash, o.alert_source, o.reference_id
  `);
  return rows[0] ?? null;
}

async function setStatus(admin: Admin, row: OutboxRow, status: string, errorCode?: string, externalId?: string | null) {
  const { error } = await admin.from("management_outbox" as never)
    .update({ status, lease_until: null, error_code: errorCode ?? null,
      ...(externalId ? { external_id: externalId } : {}) } as never)
    .eq("id", row.id).eq("organization_id", row.organization_id).eq("status", "sending");
  if (error) throw new Error(`management_delivery_status:${error.code ?? "unknown"}`);
  if (status === "failed" || status === "uncertain")
    await reportManagementDeliveryProblem(admin, { organizationId: row.organization_id,
      outboxId: row.id, uncertain: status === "uncertain" });
}

async function defer(admin: Admin, row: OutboxRow, next: Date, errorCode: string) {
  const { error } = await admin.from("management_outbox" as never)
    .update({ status: "pending", lease_until: null, next_attempt_at: next.toISOString(), error_code: errorCode } as never)
    .eq("id", row.id).eq("organization_id", row.organization_id).eq("status", "sending");
  if (error) throw new Error(`management_delivery_defer:${error.code ?? "unknown"}`);
}

/** Serializa só as saídas gerenciais da mesma sessão e mantém o ledger compartilhado. */
async function sendClaim(admin: Admin, pool: pg.Pool, row: OutboxRow): Promise<void> {
  const client = await pool.connect();
  let transportStarted = false;
  let pacingRecorded = false;
  try {
    await client.query("select pg_advisory_lock(344414, hashtext($1))", [row.channel_session_id]);
    const binding = await loadManagementBinding(admin, row.organization_id, row.channel_session_id);
    if (!binding || (row.kind === "verification"
      ? binding.verified_at || !row.verification_hash || binding.challenge_hash !== row.verification_hash
      : !binding.enabled || !binding.verified_at || (["daily", "weekly", "alert"].includes(row.kind) && binding.paused_at)
        || (row.kind === "daily" && !binding.daily_enabled)
        || (row.kind === "weekly" && !binding.weekly_enabled))) {
      await setStatus(admin, row, "cancelled", "binding_changed"); return;
    }
    if (row.dedupe_key.startsWith("reply:")) {
      const source = await admin.from("management_messages" as never).select("created_at")
        .eq("organization_id", row.organization_id).eq("channel_session_id", row.channel_session_id)
        .eq("id", row.dedupe_key.slice("reply:".length)).maybeSingle();
      if (source.error) throw new Error("management_delivery_source_unavailable");
      const createdAt = (source.data as { created_at: string } | null)?.created_at;
      if (!createdAt || !binding.verified_at || Date.parse(createdAt) < Date.parse(binding.verified_at)) {
        await setStatus(admin, row, "cancelled", "binding_changed"); return;
      }
    }
    let proposalHash: string | null = null;
    let proposalExpiresAt: number | null = null;
    if (row.kind === "consultation" && row.body_encrypted
      && row.dedupe_key.startsWith("reply:")) {
      const sourceId = row.dedupe_key.slice("reply:".length);
      const code = /\bCONFIRMAR (\d{6})\b/.exec(openVerificationBody(row.body))?.[1];
      if (!code) throw new Error("management_action_code_unavailable");
      proposalHash = managementActionCodeHash({ organizationId: row.organization_id,
        channelSessionId: row.channel_session_id, managerUserId: binding.manager_user_id }, code);
      const proposal = await admin.from("management_actions" as never).select("status, expires_at")
        .eq("organization_id", row.organization_id).eq("source_message_id", sourceId)
        .eq("manager_user_id", binding.manager_user_id).eq("channel_session_id", row.channel_session_id)
        .eq("code_hash", proposalHash).maybeSingle();
      if (proposal.error) throw new Error("management_action_delivery_unavailable");
      const action = proposal.data as { status: string; expires_at: string } | null;
      if (!action || !binding.actions_enabled || action.status !== "pending") {
        await setStatus(admin, row, "cancelled", "binding_changed"); return;
      }
      proposalExpiresAt = Date.parse(action.expires_at);
      if (Date.parse(action.expires_at) <= Date.now()) {
        const cancelled = await admin.from("management_actions" as never)
          .update({ status: "cancelled", error_code: "expired" } as never)
          .eq("organization_id", row.organization_id).eq("source_message_id", sourceId)
          .eq("status", "pending").eq("code_hash", proposalHash).select("id").maybeSingle();
        if (cancelled.error || !cancelled.data) throw new Error("management_action_expiry_unavailable");
        const body = "O comando expirou enquanto aguardava envio. Nenhuma alteração foi executada por esta proposta. Envie o pedido novamente.";
        const replaced = await admin.from("management_outbox" as never)
          .update({ body, body_encrypted: false } as never).eq("organization_id", row.organization_id)
          .eq("id", row.id).eq("status", "sending").select("id").maybeSingle();
        if (replaced.error || !replaced.data) throw new Error("management_action_expiry_reply_unavailable");
        row.body = body;
        row.body_encrypted = false;
      }
    }
    if (row.kind === "alert") {
      if (!binding.alerts_enabled || !row.alert_source || !binding.alert_categories.includes(row.alert_source)) {
        await setStatus(admin, row, "cancelled", "alert_subscription_changed"); return;
      }
      if (row.alert_source === "central_critical") {
        const current = await admin.from("agent_inbox_items").select("id")
          .eq("organization_id", row.organization_id).eq("id", row.reference_id)
          .eq("status", "open").eq("severity", "critical").maybeSingle();
        if (current.error) throw new Error("management_alert_reference_unavailable");
        if (!current.data) { await setStatus(admin, row, "cancelled", "alert_resolved"); return; }
      } else if (row.alert_source === "radar_critical") {
        const snap = await managementSnapshot(admin, row.organization_id);
        if (snap.radar.critical === 0) { await setStatus(admin, row, "cancelled", "alert_resolved"); return; }
      } else if (row.alert_source === "task_overdue") {
        const task = await admin.from("crm_tasks").select("id")
          .eq("organization_id", row.organization_id).eq("id", row.reference_id)
          .in("status", ["pending", "in_progress"]).lt("due_date", new Date().toISOString()).maybeSingle();
        if (task.error) throw new Error("management_task_alert_unavailable");
        if (!task.data) { await setStatus(admin, row, "cancelled", "alert_resolved"); return; }
      }
    }
    const [member, session] = await Promise.all([
      admin.from("user_organizations").select("id").eq("organization_id", row.organization_id)
        .eq("user_id", binding.manager_user_id).in("role", ["manager", "admin"])
        .is("revoked_at", null)
        .not("accepted_at", "is", null).maybeSingle(),
      admin.from("channel_sessions").select(`id, organization_id, status, daily_message_limit, ${CHANNEL_SESSION_REF_COLUMNS}`)
        .eq("organization_id", row.organization_id).eq("id", row.channel_session_id)
        .is("archived_at", null).maybeSingle(),
    ]);
    if (member.error || session.error) throw new Error("management_delivery_context_unavailable");
    if (!member.data) { await setStatus(admin, row, "cancelled", "membership_revoked"); return; }
    if (!session.data || session.data.status !== "WORKING") {
      await defer(admin, row, new Date(Date.now() + 60_000), "commercial_offline"); return;
    }
    const s = session.data as unknown as ChannelSessionRef & { daily_message_limit: number };
    const caps = capabilitiesOf(s.provider as ChannelProvider);
    const adapter = getAdapter(s.provider as ChannelProvider);
    const recipient = adapter.resolveRecipient({ isGroup: false, groupChatId: null,
      phoneNumber: binding.manager_phone, waIdentity: `phone:${binding.manager_phone}` });
    if (!recipient) { await setStatus(admin, row, "failed", "manager_not_addressable"); return; }

    if (!caps.freeformOutsideWindow) {
      const recent = await admin.from("management_messages" as never).select("id")
        .eq("organization_id", row.organization_id)
        .eq("channel_session_id", row.channel_session_id).eq("direction", "inbound")
        .gte("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
        .limit(1);
      if (recent.error) throw new Error("management_window_unavailable");
      if (!(recent.data ?? []).length) {
        await setStatus(admin, row, "failed", "manager_window_closed"); return;
      }
    }

    if (caps.minIntervalMs) {
      const last = await admin.from("management_outbox" as never)
        .select("updated_at").eq("organization_id", row.organization_id)
        .eq("channel_session_id", row.channel_session_id).eq("status", "accepted")
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (last.error) throw new Error("management_interval_unavailable");
      const at = (last.data as { updated_at: string } | null)?.updated_at;
      if (at && Date.now() - Date.parse(at) < caps.minIntervalMs) {
        await defer(admin, row, new Date(Date.parse(at) + caps.minIntervalMs), "recipient_interval"); return;
      }
    }

    const now = new Date();
    const config = await loadChannelKnobs(client, row.organization_id, row.channel_session_id);
    const state = await loadPacingState(client, row.organization_id, row.channel_session_id,
      { now, timezone: config.knobs.timezone, numberActivatedAt: config.numberActivatedAt });
    const start = dayStartInTz(now, config.knobs.timezone);
    const { rows: commercialRows } = await client.query<{ sent_today: string; last_sent_at: Date | null }>(`
      select count(*) filter (where sent_at >= $3) as sent_today, max(sent_at) as last_sent_at
      from public.messages where organization_id = $1 and channel_session_id = $2
        and direction = 'outbound'`, [row.organization_id, row.channel_session_id, start]);
    const commercial = commercialRows[0];
    state.sentToday = Math.max(state.sentToday, Number(commercial?.sent_today ?? 0));
    if (commercial?.last_sent_at && (!state.lastSentAt || commercial.last_sent_at > state.lastSentAt))
      state.lastSentAt = commercial.last_sent_at;
    const pacing = decidePacing({ now, knobs: config.knobs, state,
      crmDailyLimit: s.daily_message_limit, banRisk: caps.banRisk });
    if (!pacing.allow) { await defer(admin, row, pacing.nextAllowedAt, pacing.code); return; }
    if (pacing.waitMs > 0) {
      await defer(admin, row, new Date(now.getTime() + pacing.waitMs), "throttle"); return;
    }

    const beforeSend = async () => {
      const current = await loadManagementBinding(admin, row.organization_id, row.channel_session_id);
      if (!current || current.manager_phone !== binding.manager_phone
        || current.manager_user_id !== binding.manager_user_id
        || current.verified_at !== binding.verified_at
        || (row.kind === "alert" && (!current.alerts_enabled || !current.alert_categories.includes(row.alert_source ?? "")))
        || (row.kind === "consultation" && row.body_encrypted && !current.actions_enabled)
        || (row.kind === "verification"
          ? current.verified_at || current.challenge_hash !== row.verification_hash
          : !current.enabled || !current.verified_at || (["daily", "weekly", "alert"].includes(row.kind) && current.paused_at)
            || (row.kind === "daily" && !current.daily_enabled)
            || (row.kind === "weekly" && !current.weekly_enabled)))
        throw new Error("management_binding_changed_before_send");
      if (row.kind === "consultation" && row.body_encrypted
        && row.dedupe_key.startsWith("reply:")) {
        const proposal = await admin.from("management_actions" as never).select("status")
          .eq("organization_id", row.organization_id)
          .eq("manager_user_id", current.manager_user_id).eq("channel_session_id", row.channel_session_id)
          .eq("code_hash", proposalHash).gt("expires_at", new Date().toISOString())
          .eq("source_message_id", row.dedupe_key.slice("reply:".length)).maybeSingle();
        if (proposal.error || !proposal.data || (proposal.data as { status: string }).status !== "pending")
          throw new Error("management_action_changed_before_send");
      }
      const latestMember = await admin.from("user_organizations").select("id")
        .eq("organization_id", row.organization_id).eq("user_id", current.manager_user_id)
        .in("role", ["manager", "admin"]).is("revoked_at", null)
        .not("accepted_at", "is", null).maybeSingle();
      if (latestMember.error || !latestMember.data)
        throw new Error("management_membership_changed_before_send");
      const latest = await admin.from("channel_sessions").select("status")
        .eq("organization_id", row.organization_id).eq("id", row.channel_session_id)
        .is("archived_at", null).maybeSingle();
      if (latest.error || latest.data?.status !== "WORKING") throw new Error("management_commercial_changed_before_send");
      transportStarted = true;
    };
    let body = row.kind === "verification" || row.body_encrypted
      ? openVerificationBody(row.body) : row.body;
    if (row.kind === "consultation" && row.body_encrypted && proposalExpiresAt !== null) {
      const seconds = Math.max(0, Math.floor((proposalExpiresAt - Date.now()) / 1000));
      const minutes = Math.floor(seconds / 60);
      const remaining = seconds >= 60 ? `${minutes} ${minutes === 1 ? "minuto" : "minutos"}`
        : `${seconds} ${seconds === 1 ? "segundo" : "segundos"}`;
      body = body.replace(/(CONFIRMAR \d{6}) em até 10 minutos/, `$1 em até ${remaining}`);
    }
    const { externalId } = await adapter.send({ organizationId: row.organization_id,
      sessionRef: resolveSessionRef(s), to: recipient, kind: "text", body, beforeSend });
    await recordSend(client, row.organization_id, row.channel_session_id);
    pacingRecorded = true;
    if (row.kind === "verification") {
      const { data: current, error: expiryError } = await admin.from("management_bindings" as never)
        .update({ challenge_expires_at: new Date(Date.now() + 10 * 60_000).toISOString() } as never)
        .eq("organization_id", row.organization_id).eq("channel_session_id", row.channel_session_id)
        .eq("challenge_hash", row.verification_hash).select("organization_id").maybeSingle();
      if (expiryError || !current) throw new Error("management_challenge_expiry_unavailable");
      await admin.from("management_outbox" as never).update({ body: "[código de confirmação enviado]" } as never)
        .eq("organization_id", row.organization_id).eq("id", row.id);
    } else if (row.body_encrypted) {
      await admin.from("management_outbox" as never).update({ body: "[código de comando enviado]" } as never)
        .eq("organization_id", row.organization_id).eq("id", row.id);
    }
    if (!externalId) { await setStatus(admin, row, "uncertain", "transport_no_receipt"); return; }
    await setStatus(admin, row, "accepted", undefined, externalId);
  } catch {
    if (transportStarted && !pacingRecorded)
      await recordSend(client, row.organization_id, row.channel_session_id).catch(() => undefined);
    logger.error("[management] entrega falhou", {
      organization_id: row.organization_id, outbox_id: row.id,
      code: transportStarted ? "transport_uncertain" : "delivery_preflight_failed",
    });
    await setStatus(admin, row, transportStarted ? "uncertain" : "failed",
      transportStarted ? "transport_uncertain" : "delivery_preflight_failed").catch(() => undefined);
  } finally {
    await client.query("select pg_advisory_unlock(344414, hashtext($1))", [row.channel_session_id]).catch(() => undefined);
    client.release();
  }
}

export async function drainManagementOutbox(admin: Admin, pool: pg.Pool, limit = 8): Promise<number> {
  const expired = await pool.query<{ id: string; organization_id: string }>(`
    update public.management_outbox set status = 'uncertain', lease_until = null,
    error_code = 'lease_expired' where status = 'sending' and lease_until < now()
    returning id, organization_id`);
  for (const row of expired.rows) await reportManagementDeliveryProblem(admin, {
    organizationId: row.organization_id, outboxId: row.id, uncertain: true,
  });
  let handled = 0;
  while (handled < limit) {
    const row = await claim(pool);
    if (!row) break;
    await sendClaim(admin, pool, row);
    handled++;
  }
  return handled;
}
