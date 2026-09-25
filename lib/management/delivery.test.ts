import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ binding: vi.fn(), send: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "test-secret" } }));
vi.mock("@/lib/management/ingress", () => ({ loadManagementBinding: mocks.binding }));
vi.mock("@/lib/management/failure", () => ({ reportManagementDeliveryProblem: mocks.report }));
vi.mock("@/lib/management/report", () => ({ managementSnapshot: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/channels", () => ({
  capabilitiesOf: () => ({ freeformOutsideWindow: true, minIntervalMs: 0, banRisk: false }),
  CHANNEL_SESSION_REF_COLUMNS: "provider", resolveSessionRef: () => ({}),
  getAdapter: () => ({ resolveRecipient: () => "recipient", send: mocks.send }),
}));
vi.mock("@/lib/agent-engine/pacing/engine", () => ({
  decidePacing: () => ({ allow: true, waitMs: 0 }),
  dayStartInTz: () => new Date("2026-09-25T00:00:00Z"),
}));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => ({ knobs: { timezone: "UTC" }, numberActivatedAt: null }),
  loadPacingState: async () => ({ sentToday: 0, lastSentAt: null }), recordSend: vi.fn(),
}));

import { managementActionCodeHash } from "./action-code";
import { sealVerificationBody } from "./challenge-envelope";
import { drainManagementOutbox } from "./delivery";

const binding = { enabled: true, verified_at: "2026-09-01T00:00:00Z", actions_enabled: true,
  manager_user_id: "manager-a", manager_phone: "+5500000000000" };
const identity = { organizationId: "org-a", channelSessionId: "channel-a", managerUserId: "manager-a" };

function fixture() {
  const row = { id: "outbox-a", organization_id: "org-a", channel_session_id: "channel-a",
    dedupe_key: "reply:message-a", kind: "consultation", body_encrypted: true,
    body: sealVerificationBody("Criar tarefa. Para executar, responda CONFIRMAR 123456 em até 10 minutos."),
    status: "pending", verification_hash: null, alert_source: null, reference_id: null };
  const proposal = { id: "action-a", organization_id: "org-a", channel_session_id: "channel-a",
    manager_user_id: "manager-a", source_message_id: "message-a", status: "pending",
    code_hash: managementActionCodeHash(identity, "123456"), expires_at: new Date(Date.now() + 600_000).toISOString() };
  const source = { created_at: new Date().toISOString() };
  const from = vi.fn((table: string) => {
    const filters = new Map<string, unknown>();
    let patch: Record<string, unknown> | null = null;
    let after: string | null = null;
    const result = () => {
      if (table === "management_messages") return { data: source, error: null };
      if (table === "user_organizations") return { data: { id: "member-a" }, error: null };
      if (table === "channel_sessions") return { data: { id: "channel-a", status: "WORKING", provider: "test", daily_message_limit: 50 }, error: null };
      if (table !== "management_actions" && table !== "management_outbox") throw new Error(`unexpected ${table}`);
      const target = table === "management_actions" ? proposal : row;
      for (const [key, value] of filters) {
        if (Reflect.get(target, key) !== value) return { data: null, error: null };
      }
      if (after && Date.parse(proposal.expires_at) <= Date.parse(after)) return { data: null, error: null };
      if (patch) Object.assign(target, patch);
      return { data: { ...target }, error: null };
    };
    const q = { select: () => q, eq: (key: string, value: unknown) => { filters.set(key, value); return q; },
      in: () => q, is: () => q, not: () => q,
      gt: (_key: string, value: string) => { after = value; return q; },
      update: (value: Record<string, unknown>) => { patch = value; return q; },
      maybeSingle: async () => result(),
      then: (resolve: (value: ReturnType<typeof result>) => void) => Promise.resolve(result()).then(resolve),
    };
    return q;
  });
  let claimed = false;
  const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  const pool = { connect: async () => client, query: vi.fn(async (sql: string) => {
    if (!sql.includes("with picked") || claimed) return { rows: [] };
    claimed = true;
    row.status = "sending";
    return { rows: [{ ...row }] };
  }) };
  return { row, proposal, source, run: () => drainManagementOutbox({ from } as never, pool as never, 1) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.binding.mockResolvedValue(binding);
  mocks.report.mockResolvedValue(undefined);
  mocks.send.mockImplementation(async (input: { beforeSend: () => Promise<void> }) => {
    await input.beforeSend();
    return { externalId: "sent-a" };
  });
});

describe("entrega da confirmação do gestor", () => {
  it("envia o código da proposta vigente e apaga o envelope após aceitar", async () => {
    const db = fixture();
    await db.run();
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("CONFIRMAR 123456") }));
    expect(db.row.status).toBe("accepted");
    expect(db.row.body).toBe("[código de comando enviado]");
    expect(db.proposal.status).toBe("pending");
  });

  it("substitui código vencido por orientação para enviar um novo pedido", async () => {
    const db = fixture();
    db.proposal.expires_at = new Date(Date.now() - 60_000).toISOString();
    await db.run();
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("expirou enquanto aguardava envio") }));
    expect(db.row.body).not.toContain("123456");
    expect(db.row.status).toBe("accepted");
    expect(db.proposal.status).toBe("cancelled");
  });

  it("informa o prazo restante depois da espera na fila", async () => {
    const db = fixture();
    db.proposal.expires_at = new Date(Date.now() + 150_000).toISOString();
    await db.run();
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("em até 2 minutos") }));
  });

  it("não entrega um código substituído em nova tentativa de processamento", async () => {
    const db = fixture();
    db.proposal.code_hash = managementActionCodeHash(identity, "654321");
    await db.run();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(db.row.status).toBe("cancelled");
  });

  it("não entrega proposta preparada para outro gestor", async () => {
    const db = fixture();
    db.proposal.manager_user_id = "manager-b";
    await db.run();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(db.row.status).toBe("cancelled");
  });

  it("não entrega resposta de uma pergunta anterior ao vínculo atual", async () => {
    const db = fixture();
    db.source.created_at = "2026-08-01T00:00:00Z";
    db.row.body_encrypted = false;
    db.row.body = "Resposta antiga";
    await db.run();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(db.row.status).toBe("cancelled");
  });
});
