"use client";

import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface Session { id: string; display_name: string | null; phone_number: string | null; status: string }
interface Member { user_id: string; role: string; accepted_at: string | null; revoked_at: string | null;
  full_name: string | null; email: string | null }
interface Binding { channel_session_id: string; manager_user_id: string; manager_name: string;
  manager_phone: string; enabled: boolean; verified_at: string | null; daily_enabled: boolean;
  daily_hour: number; alerts_enabled: boolean; alert_categories: string[];
  max_daily_alerts: number; paused_at: string | null; challenge_expires_at: string | null }
interface History { id: string; kind: string; status: string; error_code: string | null;
  delivered_at: string | null; read_at: string | null; created_at: string }

const ERRORS: Record<string, string> = {
  commercial_offline: "Comercial desconectado: reconecte o WhatsApp.",
  manager_window_closed: "Janela fechada: peça ao gestor para iniciar a conversa pelo WhatsApp.",
  manager_not_addressable: "Número do gestor não pôde ser endereçado: confira o cadastro.",
  transport_uncertain: "Envio incerto: confira o comercial antes de qualquer nova tentativa.",
  transport_no_receipt: "Envio sem recibo: confira o comercial antes de tentar de novo.",
  lease_expired: "Envio interrompido: confira o comercial antes de tentar de novo.",
  provider_delivery_failed: "O canal informou falha de entrega: confira a conexão.",
  delivery_preflight_failed: "Falha antes do envio: revise conexão, horário e configuração.",
  binding_changed: "Cadastro alterado: mensagem antiga cancelada.",
  membership_revoked: "Acesso do gestor revogado: mensagem cancelada.",
  alert_resolved: "Aviso resolvido antes do envio.",
};

function deliveryLabel(h: History, t: (text: string) => string): string {
  if (h.error_code === "provider_delivery_failed") return t("falha de entrega");
  if (h.read_at) return t("lida");
  if (h.delivered_at) return t("entregue");
  const labels: Record<string, string> = { pending: "aguardando", sending: "enviando",
    accepted: "aceita pelo canal", failed: "falhou antes do envio",
    uncertain: "resultado incerto", cancelled: "cancelada" };
  const label = labels[h.status];
  return label ? t(label) : h.status;
}
interface Settings { binding: Binding | null; history: History[]; sessions: Session[]; members: Member[] }

const EMPTY: Binding = { channel_session_id: "", manager_user_id: "", manager_name: "",
  manager_phone: "", enabled: false, verified_at: null, daily_enabled: false,
  daily_hour: 9, alerts_enabled: false, alert_categories: [], max_daily_alerts: 3,
  paused_at: null, challenge_expires_at: null };

async function read<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const payload = await res.json() as { data?: T; error?: { message: string } };
  if (!res.ok || payload.data === undefined) throw new Error(payload.error?.message ?? "Não foi possível carregar.");
  return payload.data;
}

export function ManagementSettingsClient({ organizationName, readOnly }: { organizationName: string; readOnly: boolean }) {
  const t = useT();
  const dateLocale = useTagDeIdioma();
  const [form, setForm] = useState<Binding>(EMPTY);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [resumeAlerts, setResumeAlerts] = useState(false);

  const applySettings = (settings: Settings) => {
    setForm(settings.binding ?? EMPTY);
    setHistory(settings.history);
    setSessions(settings.sessions);
    setMembers(settings.members);
  };
  const refresh = async () => applySettings(await read<Settings>("/api/v1/management/settings"));
  useEffect(() => {
    void read<Settings>("/api/v1/management/settings").then(applySettings)
      .catch((err: unknown) => setMessage(err instanceof Error ? err.message : "Falha ao carregar."));
  }, []);

  const patch = (part: Partial<Binding>) => setForm((old) => ({ ...old, ...part }));
  const send = async (url: string, method: "PATCH" | "POST", body?: object) => {
    setBusy(true); setMessage("");
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await res.json() as { error?: { message: string } };
      if (!res.ok) throw new Error(result.error?.message ?? "Falha ao salvar.");
      setMessage(method === "PATCH" ? t("Configuração salva.")
        : url.endsWith("/retry") ? t("Falha recolocada na fila. Confira o histórico para acompanhar o envio.")
        : t("Código colocado na fila do comercial. Aguarde a entrega e peça ao gestor para responder no WhatsApp."));
      await refresh();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Falha ao salvar."); }
    finally { setBusy(false); }
  };
  const save = () => void send("/api/v1/management/settings", "PATCH", {
    channel_session_id: form.channel_session_id, manager_user_id: form.manager_user_id,
    manager_name: form.manager_name, manager_phone: form.manager_phone,
    enabled: form.enabled, daily_enabled: form.daily_enabled, daily_hour: form.daily_hour,
    alerts_enabled: form.alerts_enabled, alert_categories: form.alert_categories,
    max_daily_alerts: form.max_daily_alerts, resume_alerts: resumeAlerts,
  });
  const category = (id: string, checked: boolean) => patch({ alert_categories: checked
    ? [...new Set([...form.alert_categories, id])]
    : form.alert_categories.filter((kind) => kind !== id) });

  return <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
    <header><h1 className="text-2xl font-semibold">{t("Assistente de gestão no WhatsApp")}</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">{t("Empresa")}: {organizationName}. {t("O gestor conversa com o número comercial conectado desta empresa. Consultas não alteram leads ou atendimentos.")}</p>
    </header>
    {readOnly && <p role="status" className="rounded-md border p-3">{t("Acompanhamento somente leitura: configuração e teste estão bloqueados.")}</p>}
    {message && <p role="status" className="rounded-md border p-3">{t(message)}</p>}
    <section className="grid max-w-3xl gap-4 rounded-md border p-4">
      <h2 className="font-semibold">{t("Gestor e comercial")}</h2>
      <label className="grid gap-1 text-sm">{t("WhatsApp comercial conectado")}
        <select aria-label={t("WhatsApp comercial conectado")} className="rounded-md border bg-background p-2" disabled={readOnly || busy}
          value={form.channel_session_id} onChange={(e) => patch({ channel_session_id: e.target.value })}>
          <option value="">{t("Selecione a conexão")}</option>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.display_name ?? s.phone_number ?? t("Número comercial")} · {s.status}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">{t("Usuário gestor da empresa")}
        <select aria-label={t("Usuário gestor da empresa")} className="rounded-md border bg-background p-2" disabled={readOnly || busy}
          value={form.manager_user_id} onChange={(e) => patch({ manager_user_id: e.target.value })}>
          <option value="">{t("Selecione o gestor")}</option>
          {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name ?? m.email ?? m.user_id.slice(0, 8)} · {m.role}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">{t("Nome do gestor")}
        <input className="rounded-md border bg-background p-2" disabled={readOnly || busy} maxLength={120}
          value={form.manager_name} onChange={(e) => patch({ manager_name: e.target.value })} />
      </label>
      <label className="grid gap-1 text-sm">{t("WhatsApp do gestor com DDI")}
        <input className="rounded-md border bg-background p-2" disabled={readOnly || busy} inputMode="tel"
          value={form.manager_phone} onChange={(e) => patch({ manager_phone: e.target.value })} placeholder="+55..." />
      </label>
      <p className="text-sm">{t("Número")} {form.verified_at ? t("confirmado") : t("ainda não confirmado")}. {form.challenge_expires_at && t("Código enviado; aguarde resposta do gestor.")}</p>
      <button className="w-fit rounded-md border px-3 py-1 text-sm disabled:opacity-50" disabled={busy}
        onClick={() => void refresh().catch((err: unknown) => setMessage(err instanceof Error ? err.message : t("Falha ao atualizar.")))}>{t("Atualizar confirmação e histórico")}</button>
      <label className="flex gap-2 text-sm"><input type="checkbox" disabled={readOnly || busy || !form.verified_at}
        checked={form.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />{t("Ativar consultas pelo WhatsApp")}</label>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={readOnly || busy || !form.channel_session_id || !form.manager_user_id || !form.manager_name || !form.manager_phone} onClick={save}>{t("Salvar configuração")}</button>
        <button className="rounded-md border px-4 py-2 disabled:opacity-50" disabled={readOnly || busy || !form.channel_session_id || !!form.verified_at}
          onClick={() => void send("/api/v1/management/verification", "POST")}>{t("Enviar código pelo comercial")}</button>
      </div>
    </section>
    <section className="grid max-w-3xl gap-3 rounded-md border p-4">
      <h2 className="font-semibold">{t("Resumo e avisos")}</h2>
      <label className="flex gap-2 text-sm"><input type="checkbox" disabled={readOnly || busy} checked={form.daily_enabled}
        onChange={(e) => patch({ daily_enabled: e.target.checked })} />{t("Enviar resumo diário")}</label>
      <label className="grid gap-1 text-sm">{t("Hora local da empresa")}
        <input type="number" min={0} max={23} className="w-24 rounded-md border bg-background p-2" disabled={readOnly || busy}
          value={form.daily_hour} onChange={(e) => patch({ daily_hour: Number(e.target.value) })} />
      </label>
      <label className="flex gap-2 text-sm"><input type="checkbox" disabled={readOnly || busy} checked={form.alerts_enabled}
        onChange={(e) => patch({ alerts_enabled: e.target.checked })} />{t("Enviar alertas selecionados")}</label>
      <label className="flex gap-2 text-sm"><input type="checkbox" disabled={readOnly || busy}
        checked={form.alert_categories.includes("central_critical")}
        onChange={(e) => category("central_critical", e.target.checked)} />{t("Aviso crítico da Central")}</label>
      <label className="flex gap-2 text-sm"><input type="checkbox" disabled={readOnly || busy}
        checked={form.alert_categories.includes("radar_critical")}
        onChange={(e) => category("radar_critical", e.target.checked)} />{t("Negócios críticos do Radar")}</label>
      <label className="grid gap-1 text-sm">{t("Máximo de alertas por dia")}
        <input type="number" min={0} max={20} className="w-24 rounded-md border bg-background p-2" disabled={readOnly || busy}
          value={form.max_daily_alerts} onChange={(e) => patch({ max_daily_alerts: Number(e.target.value) })} />
      </label>
      {form.paused_at && <label className="flex gap-2 text-sm"><input type="checkbox" disabled={readOnly || busy}
        checked={resumeAlerts} onChange={(e) => setResumeAlerts(e.target.checked)} />{t("Reativar avisos pausados pelo gestor")}</label>}
      <button className="w-fit rounded-md border px-4 py-2 disabled:opacity-50" disabled={readOnly || busy || !form.channel_session_id} onClick={save}>{t("Salvar resumo e avisos")}</button>
    </section>
    <section className="max-w-3xl rounded-md border p-4"><h2 className="font-semibold">{t("Histórico de entregas")}</h2>
      <p className="text-sm text-muted-foreground">{t("Aceita pelo transporte não significa lida pelo gestor. Falhas e resultados incertos exigem revisão.")}</p>
      <ul className="mt-3 space-y-1 text-sm">{history.map((h) => <li key={h.id}>
        {new Date(h.created_at).toLocaleString(dateLocale)} · {h.kind} · {deliveryLabel(h, t)}
        {h.error_code && <span className="ml-1 text-muted-foreground">· {t(ERRORS[h.error_code] ?? "Confira o estado do envio com o suporte.")}</span>}
        {h.status === "failed" && !readOnly && <button className="ml-2 rounded-md border px-2 py-1 disabled:opacity-50"
          disabled={busy} onClick={() => void send(`/api/v1/management/outbox/${h.id}/retry`, "POST")}>{t("Tentar novamente")}</button>}
      </li>)}</ul>
    </section>
  </div>;
}
