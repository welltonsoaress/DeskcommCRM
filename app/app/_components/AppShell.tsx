"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { useInboundMessageAlerts } from "@/hooks/notifications/useInboundMessageAlerts";
import { useCrmAlerts } from "@/hooks/notifications/useCrmAlerts";
import { useNotifyOpenFromServiceWorker } from "@/lib/notifications/notify_open";
import { usePendingCases } from "@/hooks/ai/useCases";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useT } from "@/hooks/i18n/useT";
import { X } from "@/lib/ui/icons";

interface AppShellProps {
  sidebarCollapsed: boolean;
  children: ReactNode;
}

export function AppShell({ sidebarCollapsed, children }: AppShellProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const { user, activeOrg } = useAuth();
  const pendingCases = usePendingCases();
  const organizationId = activeOrg?.orgId ?? null;
  const canReadCases =
    !!organizationId &&
    !!activeOrg?.role &&
    !user.support &&
    ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const occurrenceStorageKey = `casos-aviso:${user.id}:${organizationId ?? "sem-org"}`;
  const announcedOccurrences = useRef(new Set<string>());
  const initialCasesRead = useRef(false);
  const [caseNotice, setCaseNotice] = useState<{ scopeKey: string; keys: string[] } | null>(null);

  useEffect(() => {
    initialCasesRead.current = false;
    announcedOccurrences.current.clear();
  }, [occurrenceStorageKey]);

  // O escopo da notificação acompanha usuário e organização. Assim a troca de
  // organização esconde imediatamente o aviso anterior sem cascata de state em
  // effect nem possibilidade de exibir uma ocorrência de outra organização.
  const caseNoticeInScope =
    canReadCases && caseNotice?.scopeKey === occurrenceStorageKey ? caseNotice : null;

  const occurrenceWasDismissed = useCallback((key: string) => {
    try {
      const stored = window.localStorage.getItem(occurrenceStorageKey);
      return stored ? (JSON.parse(stored) as string[]).includes(key) : false;
    } catch {
      return false;
    }
  }, [occurrenceStorageKey]);

  const dismissalsForActiveCases = useCallback((activeKeys: string[]) => {
    try {
      const stored = window.localStorage.getItem(occurrenceStorageKey);
      const dismissed = new Set<string>(
        stored
          ? (JSON.parse(stored) as unknown[]).filter((key): key is string => typeof key === "string")
          : [],
      );
      const active = new Set(activeKeys);
      const retained = [...dismissed].filter((key) => active.has(key));
      if (retained.length !== dismissed.size) {
        window.localStorage.setItem(occurrenceStorageKey, JSON.stringify(retained));
      }
      return new Set(retained);
    } catch {
      return new Set<string>();
    }
  }, [occurrenceStorageKey]);

  useEffect(() => {
    if (!canReadCases || !pendingCases.isSuccess) return;
    const rows = pendingCases.data.pending_cases;
    const keys = rows.map((row) => `${row.id}:${row.awaiting_human_at}`);
    const dismissed = dismissalsForActiveCases(keys);
    const freshKeys = keys.filter(
      (key) => !announcedOccurrences.current.has(key) && !dismissed.has(key),
    );
    keys.forEach((key) => announcedOccurrences.current.add(key));
    const firstRead = !initialCasesRead.current;
    initialCasesRead.current = true;
    // Na primeira leitura, todas as pendências ativas precisam de visibilidade.
    // Nas seguintes, só notificamos ocorrências novas que o Realtime talvez não
    // tenha entregue durante uma reconexão.
    const visibleKeys = firstRead
      ? keys.filter((key) => !dismissed.has(key))
      : freshKeys;
    const activeKeys = new Set(keys);
    setCaseNotice((current) => {
      const currentKeys = current?.scopeKey === occurrenceStorageKey ? current.keys : [];
      const stillActive = currentKeys.filter((key) => activeKeys.has(key));
      const merged = [...new Set([...stillActive, ...visibleKeys])];
      if (
        merged.length === currentKeys.length &&
        merged.every((key, index) => key === currentKeys[index])
      ) return current;
      return merged.length > 0 ? { scopeKey: occurrenceStorageKey, keys: merged } : null;
    });
  }, [canReadCases, pendingCases.isSuccess, pendingCases.data, dismissalsForActiveCases, occurrenceStorageKey]);

  const handleCaseChange = useCallback((payload: unknown) => {
    if (!canReadCases) return;
    void queryClient.invalidateQueries({ queryKey: ["pending-ai-cases", organizationId] });
    void queryClient.invalidateQueries({ queryKey: ["ai-cases", organizationId] });
    void queryClient.invalidateQueries({ queryKey: ["ai-case", organizationId] });
    if (!payload || typeof payload !== "object") return;
    const event = payload as {
      eventType?: string;
      new?: Record<string, unknown>;
      old?: Record<string, unknown>;
    };
    const next = event.new;
    const previous = event.old;
    if (
      previous?.status === "awaiting_human" &&
      next?.status !== "awaiting_human" &&
      typeof previous.id === "string"
    ) {
      setCaseNotice((current) => {
        if (current?.scopeKey !== occurrenceStorageKey) return current;
        const remaining = current.keys.filter((key) => !key.startsWith(`${previous.id}:`));
        return remaining.length > 0 ? { ...current, keys: remaining } : null;
      });
      return;
    }
    if (
      next?.status !== "awaiting_human" ||
      (event.eventType !== "INSERT" && previous?.status === "awaiting_human") ||
      typeof next.id !== "string" ||
      typeof next.awaiting_human_at !== "string"
    ) return;
    const key = `${next.id}:${next.awaiting_human_at}`;
    if (announcedOccurrences.current.has(key) || occurrenceWasDismissed(key)) return;
    announcedOccurrences.current.add(key);
    setCaseNotice((current) => ({
      scopeKey: occurrenceStorageKey,
      keys: [...new Set([...(current?.scopeKey === occurrenceStorageKey ? current.keys : []), key])],
    }));
  }, [canReadCases, organizationId, occurrenceStorageKey, occurrenceWasDismissed, queryClient]);

  useRealtimeChannel({
    name: `casos-pendentes:${organizationId ?? "sem-org"}`,
    postgresChanges: organizationId
      ? { event: "*", schema: "public", table: "agent_cases", filter: `organization_id=eq.${organizationId}` }
      : undefined,
    enabled: canReadCases,
    onChange: handleCaseChange,
  });

  function dismissCaseNotice() {
    if (caseNoticeInScope) {
      try {
        const stored = window.localStorage.getItem(occurrenceStorageKey);
        const dismissed = new Set<string>(stored ? JSON.parse(stored) as string[] : []);
        caseNoticeInScope.keys.forEach((key) => dismissed.add(key));
        const activeKeys = new Set([
          ...(pendingCases.data?.pending_cases.map((row) => `${row.id}:${row.awaiting_human_at}`) ?? []),
          ...caseNoticeInScope.keys,
        ]);
        window.localStorage.setItem(
          occurrenceStorageKey,
          JSON.stringify([...dismissed].filter((key) => activeKeys.has(key))),
        );
      } catch {
        // Fechar o aviso continua funcionando se o navegador bloquear storage.
      }
    }
    setCaseNotice((current) =>
      current?.scopeKey === occurrenceStorageKey ? null : current,
    );
  }

  const pendingCount = canReadCases ? (pendingCases.data?.pending_count ?? 0) : 0;
  useInboundMessageAlerts();
  useCrmAlerts();
  useNotifyOpenFromServiceWorker();
  return (
    <div className="flex min-h-screen w-full bg-background">
      <div className="hidden md:block">
        <Sidebar
          collapsed={sidebarCollapsed}
          pendingCasesCount={pendingCount}
          pendingCasesUnknown={!pendingCases.isSuccess}
        />
      </div>
      {/*
        `min-w-0` é o que permite a coluna de conteúdo ENCOLHER. Um flex item
        nasce com `min-width: auto`, ou seja, nunca fica menor que o conteúdo —
        então qualquer bloco largo (uma fila de abas, uma tabela) empurrava a
        PÁGINA INTEIRA para o lado em vez de rolar dentro da própria caixa, e o
        conteúdo sumia sem nada indicando que existia.

        Medido em 390x844 no detalhe do agente, que tem seis abas: a página
        estourava 476px na horizontal; com esta classe, 212px — o que sobra é o
        cabeçalho, presente também em telas que não têm abas (a lista de agentes
        estoura 236px). Isolado ancestral por ancestral: é este o que decide.
      */}
      {/*
        Sem `md:ml-*`: a barra voltou a ocupar lugar na linha (ver o comentário
        em `Sidebar.tsx`), então o que sobra para esta coluna é exatamente o que
        ela não usou. A margem existia para compensar uma barra `fixed`, e era a
        SEGUNDA medida da mesma coisa — a que discordava e deixava a barra por
        cima da lista.
      */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <TopBar pendingCasesCount={pendingCount} pendingCasesUnknown={!pendingCases.isSuccess} />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
      {caseNoticeInScope && (
        <aside
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-red-300 bg-background p-4 shadow-xl"
        >
          <div className="flex items-start gap-3">
            <span className="mt-1 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-600 motion-reduce:animate-none" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{t("Há casos aguardando ação humana")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("Revise os casos para dar continuidade ao atendimento.")}
              </p>
              <Link
                href="/app/ai/cases"
                className="pointer-events-auto mt-3 inline-flex rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                onClick={dismissCaseNotice}
              >
                {t("Abrir casos")}
              </Link>
            </div>
            <button
              type="button"
              onClick={dismissCaseNotice}
              aria-label={t("Fechar aviso")}
              title={t("Fechar aviso")}
              className="pointer-events-auto inline-flex items-center gap-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X size={16} aria-hidden />
              <span className="text-xs">{t("Fechar")}</span>
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
