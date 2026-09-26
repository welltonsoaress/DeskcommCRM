"use client";
import { useRef, useState } from "react";

import { X } from "@/lib/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { useAuth } from "@/hooks/auth/AuthProvider";
type Draft = {
  id: string;
  revision: string;
  status: string;
  original_body: string | null;
  edited_body: string | null;
  error_code: string | null;
  proposals: Array<{ tool: string; arguments: unknown }>;
};
export function ReplyReviewPanel({
  conversationId,
  disabled,
}: {
  conversationId: string;
  disabled?: boolean;
}) {
  const { activeOrg } = useAuth();
  const organizationId = activeOrg?.orgId ?? null;
  const interactionKey = `${organizationId ?? "sem-org"}:${conversationId}`;
  return (
    <ReplyReviewPanelInstance
      key={interactionKey}
      organizationId={organizationId}
      conversationId={conversationId}
      disabled={disabled}
    />
  );
}

function ReplyReviewPanelInstance({
  organizationId,
  conversationId,
  disabled,
}: {
  organizationId: string | null;
  conversationId: string;
  disabled?: boolean;
}) {
  const t = useT(),
    qc = useQueryClient(),
    key = ["reply-drafts", organizationId, conversationId];
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      apiClient.get<{ data: { drafts: Draft[] } }>(
        `/api/v1/conversations/${conversationId}/draft-reply`,
      ),
    refetchInterval: 4000,
    retry: false,
  });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  // A tela do Inbox começa compacta; gerar ou abrir a sugestão expande o painel.
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<{
    draftId: string;
    message: string;
    kind: "success" | "error";
  } | null>(null);
  const requestInFlight = useRef(false);
  const draft = query.data?.data.drafts[0];
  const body = draft ? (edits[draft.id] ?? draft.edited_body ?? draft.original_body ?? "") : "";
  async function generate() {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setNotice(null);
    setExpanded(true);
    setBusy(true);
    try {
      await apiClient.post(`/api/v1/conversations/${conversationId}/draft-reply`, {});
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      showApiError(e);
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  }
  async function decide(action: "approve" | "reject") {
    if (!draft || requestInFlight.current) return;
    requestInFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await apiClient.post(`/api/v1/ai/replies/${draft.id}`, {
        action,
        revision: draft.revision,
        body,
        feedback,
      });
      if (action === "approve") setExpanded(false);
      setNotice({
        draftId: draft.id,
        kind: "success",
        message:
          action === "approve"
            ? t("Resposta aprovada. Acompanhe o envio aqui.")
            : t("Sugestão rejeitada. O feedback será usado na próxima sugestão."),
      });
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      showApiError(e);
      setNotice({
        draftId: draft.id,
        kind: "error",
        message: t(
          "Sua edição foi preservada. Confira se a conversa mudou antes de aprovar novamente.",
        ),
      });
      await qc.invalidateQueries({ queryKey: key });
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  }
  const statuses: Record<string, string> = {
    generating: "Preparando sugestão…",
    pending: "Sugestão para revisar",
    approved: "Resposta aprovada: aguardando envio",
    sending: "Enviando resposta aprovada…",
    sent: "Resposta aprovada enviada",
    dismissed: "Sugestão rejeitada",
    stale: "Sugestão obsoleta: a conversa mudou",
    failed: "Não foi possível concluir a sugestão ou o envio",
  };
  if (!expanded) {
    return (
      <section className="mb-3 flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
        <p className="truncate text-xs text-muted-foreground">
          {t(draft ? (statuses[draft.status] ?? "Sugestão disponível") : "Assistência do agente")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={() => (draft ? setExpanded(true) : generate())}
        >
          {t(draft ? "Ver sugestão" : "Sugerir resposta")}
        </Button>
      </section>
    );
  }
  return (
    <section
      className="mb-3 space-y-2 rounded-md border bg-muted/30 p-3"
      aria-label={t("Assistência do agente")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {t(draft ? (statuses[draft.status] ?? "Assistência do agente") : "Assistência do agente")}
        </p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={generate}
          >
            {t(busy ? "Preparando…" : "Sugerir resposta")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={t("Fechar sugestão")}
            title={t("Fechar sugestão")}
            onClick={() => setExpanded(false)}
          >
            <X size={16} aria-hidden />
          </Button>
        </div>
      </div>
      {draft && (
        <>
          <p className="text-xs text-muted-foreground">
            {t(
              "Aprovar envia somente este texto. Não altera dados, agenda ou a autonomia do agente.",
            )}
          </p>
          {body && (
            <Textarea
              aria-label={t("Resposta sugerida")}
              value={body}
              onChange={(e) => setEdits({ ...edits, [draft.id]: e.target.value })}
              disabled={disabled || busy || draft.status !== "pending"}
              rows={3}
            />
          )}
          {draft.proposals.length > 0 && (
            <details className="text-xs">
              <summary>{t("Ações propostas: precisam de autorização separada")}</summary>
              <p>{t("Abra a ação correspondente no CRM ou na agenda para confirmar.")}</p>
              <ul>
                {draft.proposals.map((p, i) => (
                  <li key={i}>{p.tool}</li>
                ))}
              </ul>
            </details>
          )}
          {draft.status === "pending" && (
            <>
              <Input
                aria-label={t("Feedback para a próxima sugestão")}
                placeholder={t("Feedback para a próxima sugestão")}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                maxLength={1000}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled || busy || !body.trim()}
                  onClick={() => decide("approve")}
                >
                  {t("Aprovar e enviar")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || busy}
                  onClick={() => decide("reject")}
                >
                  {t("Rejeitar")}
                </Button>
              </div>
            </>
          )}
          {draft.status === "failed" && (
            <p className="text-xs">
              {t("Confira a configuração do agente e tente gerar novamente.")}
            </p>
          )}
        </>
      )}
      {notice &&
        draft &&
        notice.draftId === draft.id &&
        (notice.kind === "error" ||
          ["approved", "sending", "sent", "dismissed"].includes(draft.status)) && (
          <p role="status" className="text-xs">
            {notice.message}
          </p>
        )}
    </section>
  );
}
