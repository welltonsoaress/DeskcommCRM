import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ManagementFailure from "@/lib/management/failure";

const mocks = vi.hoisted(() => ({ answer: vi.fn(), binding: vi.fn(), enqueue: vi.fn(),
  report: vi.fn(), resolve: vi.fn(), weekly: vi.fn(), weeklyText: vi.fn() }));
vi.mock("@/lib/management/consultation", () => ({ answerManagementQuestion: mocks.answer }));
vi.mock("@/lib/management/actions", () => ({ confirmManagementAction: vi.fn() }));
vi.mock("@/lib/management/ingress", () => ({ loadManagementBinding: mocks.binding }));
vi.mock("@/lib/management/outbox", () => ({ enqueueManagementDelivery: mocks.enqueue }));
vi.mock("@/lib/management/report", () => ({ managementSnapshot: vi.fn(), formatManagementSummary: vi.fn(),
  managementWeeklyComparison: mocks.weekly, formatManagementWeeklyComparison: mocks.weeklyText }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/management/failure", async (original) => ({
  ...await original<typeof ManagementFailure>(),
  reportManagementProcessingProblem: mocks.report, resolveManagementProcessingProblem: mocks.resolve,
}));
import { produceManagementReplies, produceManagementSchedule } from "./schedule";

function fixture(count = 1) {
  let now = Date.now();
  const messages = Array.from({ length: count }, (_, i) => ({ id: `message-${i}`,
    organization_id: "org-a", channel_session_id: "channel-a", kind: "consultation",
    body: "resumo do dia", created_at: new Date(now), lease: 0 }));
  const outbox = new Map<string, string>();
  const pool = { query: vi.fn(async (sql: string, values: string[] = []) => {
    if (sql.includes("with picked")) {
      const msg = messages.find((m) => m.kind !== "ignored" && m.lease < now && !outbox.has(`reply:${m.id}`));
      if (!msg) return { rows: [] };
      msg.lease = now + 300_000;
      return { rows: [{ ...msg }] };
    }
    if (sql.includes("kind = 'ignored'")) {
      const msg = messages.find((m) => m.organization_id === values[0] && m.id === values[1]);
      if (msg) msg.kind = "ignored";
      return { rows: [] };
    }
    throw new Error("unexpected_query");
  }) };
  const membership = { select: () => membership, eq: () => membership, in: () => membership,
    is: () => membership, not: () => membership,
    maybeSingle: async () => ({ data: { id: "member-a" }, error: null }) };
  const admin = { from: () => membership };
  mocks.enqueue.mockImplementation(async (_admin: unknown, { dedupeKey, body }: { dedupeKey: string; body: string }) => {
    if (outbox.has(dedupeKey)) return false;
    outbox.set(dedupeKey, body); return true;
  });
  return { outbox, retry: () => { now += 300_001; },
    run: (limit = 2) => produceManagementReplies(admin as never, pool as never, limit) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.binding.mockResolvedValue({ enabled: true, verified_at: "2026-09-01", manager_user_id: "manager-a" });
  mocks.answer.mockResolvedValue("Resumo medido");
  mocks.report.mockResolvedValue(undefined);
  mocks.resolve.mockResolvedValue(undefined);
  mocks.weekly.mockResolvedValue({ current: {}, previous: {} });
  mocks.weeklyText.mockReturnValue("Comparativo semanal medido");
});

it("enfileira o comparativo semanal uma vez no dia e hora locais configurados", async () => {
  const binding = { organization_id: "org-a", channel_session_id: "channel-a",
    daily_enabled: false, daily_hour: 9, weekly_enabled: true, weekly_day: 1,
    weekly_hour: 9, alerts_enabled: false, alert_categories: [], max_daily_alerts: 0,
    paused_at: null, timezone: "UTC" };
  const pool = { query: vi.fn(async () => ({ rows: [binding] })) };
  const q = { select: () => q, eq: () => q, limit: async () => ({ data: [], error: null }) };
  const admin = { from: () => q };
  mocks.enqueue.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const now = new Date("2026-09-28T09:05:00Z");
  expect(await produceManagementSchedule(admin as never, pool as never, now))
    .toEqual({ daily: 0, weekly: 1, alerts: 0 });
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    kind: "weekly", dedupeKey: "weekly:2026-09-28", body: "Comparativo semanal medido",
  }));
  expect(await produceManagementSchedule(admin as never, pool as never, now))
    .toEqual({ daily: 0, weekly: 0, alerts: 0 });
});

it("avisa tarefa vencida aberta dentro do limite diário configurado", async () => {
  const binding = { organization_id: "org-a", channel_session_id: "channel-a",
    daily_enabled: false, daily_hour: 9, weekly_enabled: false, weekly_day: 1,
    weekly_hour: 9, alerts_enabled: true, alert_categories: ["task_overdue"],
    max_daily_alerts: 1, paused_at: null, timezone: "UTC" };
  const pool = { query: vi.fn(async (sql: string) => ({ rows: sql.includes("select b.organization_id")
    ? [binding] : [{ id: "task-a" }] })) };
  const q = { select: () => q, eq: () => q, gte: () => q,
    then: (resolve: (value: { count: number; error: null }) => void) =>
      Promise.resolve({ count: 0, error: null }).then(resolve) };
  mocks.enqueue.mockResolvedValue(true);
  expect(await produceManagementSchedule({ from: () => q } as never, pool as never,
    new Date("2026-09-28T09:05:00Z")))
    .toEqual({ daily: 0, weekly: 0, alerts: 1 });
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    kind: "alert", alertSource: "task_overdue", dedupeKey: "alert:task:task-a",
  }));
});

describe("recuperação das consultas do gestor", () => {
  it("ignora pergunta recebida antes da verificação do gestor atual", async () => {
    const db = fixture();
    mocks.binding.mockResolvedValue({ enabled: true, verified_at: new Date(Date.now() + 60_000).toISOString(), manager_user_id: "manager-b" });
    expect(await db.run()).toBe(0);
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(db.outbox.size).toBe(0);
  });

  it("descarta resposta se o vínculo mudar durante o processamento", async () => {
    const db = fixture();
    mocks.answer.mockImplementation(async () => {
      mocks.binding.mockResolvedValue({ enabled: true, verified_at: "2026-09-25", manager_user_id: "manager-b" });
      return "Resposta do gestor anterior";
    });
    expect(await db.run()).toBe(0);
    expect(db.outbox.size).toBe(0);
  });

  it("retoma após erro de processamento e falha da resposta de contingência, sem perder a pergunta", async () => {
    const db = fixture();
    mocks.answer.mockRejectedValueOnce(new Error("management_context_unavailable"));
    mocks.enqueue.mockRejectedValueOnce(new Error("management_outbox_insert:08006"));
    expect(await db.run()).toBe(0);
    expect(db.outbox.size).toBe(0);
    db.retry();
    expect(await db.run()).toBe(1);
    expect(db.outbox.get("reply:message-0")).toBe("Resumo medido");
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), "org-a", "message-0");
  });

  it("um erro não impede a próxima pergunta e a resposta de contingência é contada", async () => {
    const db = fixture(2);
    mocks.answer.mockRejectedValueOnce(new Error("management_context_unavailable"));
    expect(await db.run()).toBe(2);
    expect(db.outbox.get("reply:message-0")).toContain("Não consegui preparar");
    expect(db.outbox.get("reply:message-1")).toBe("Resumo medido");
    expect(mocks.resolve).not.toHaveBeenCalledWith(expect.anything(), "org-a", "message-0");
    expect(await db.run()).toBe(0);
  });

  it("falha na outbox preserva a pergunta para gerar uma resposta normal na retomada", async () => {
    const db = fixture();
    mocks.enqueue.mockRejectedValueOnce(new Error("management_outbox_insert:08006"));
    expect(await db.run()).toBe(0);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    db.retry();
    expect(await db.run()).toBe(1);
    expect(db.outbox.get("reply:message-0")).toBe("Resumo medido");
  });

  it("respeita o limite mesmo quando todas as consultas falham", async () => {
    const db = fixture(3);
    mocks.answer.mockRejectedValue(new Error("management_context_unavailable"));
    expect(await db.run(2)).toBe(2);
    expect(mocks.answer).toHaveBeenCalledTimes(2);
    expect(db.outbox.size).toBe(2);
  });
});
