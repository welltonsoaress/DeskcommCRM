import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "test-secret" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/management/outbox", () => ({ enqueueManagementDelivery: vi.fn() }));
vi.mock("@/lib/management/failure", () => ({ reportUnsignedManagerIngress: vi.fn() }));

import { interceptManagementMessage } from "./ingress";

function scopedAdmin(bindingOrg: string, bindingSession: string) {
  const insert = vi.fn();
  const from = vi.fn((table: string) => {
    if (table !== "management_bindings") throw new Error(`unexpected table: ${table}`);
    const filters: string[] = [];
    const query = {
      select: () => query,
      eq: (key: string, value: string) => { filters.push(`${key}:${value}`); return query; },
      maybeSingle: async () => ({ data: filters.includes(`organization_id:${bindingOrg}`)
        && filters.includes(`channel_session_id:${bindingSession}`) ? {
          organization_id: bindingOrg, channel_session_id: bindingSession,
          manager_phone: "+5511999999999", verified_at: null,
        } : null, error: null }),
    };
    return { ...query, insert };
  });
  return { admin: { from } as never, from, insert };
}

describe("audiência gerencial antes do funil", () => {
  it("não toma o vínculo de outra empresa ou conexão como autorização", async () => {
    const db = scopedAdmin("org-a", "session-a");
    const intercepted = await interceptManagementMessage(db.admin, {
      organizationId: "org-b", channelSessionId: "session-a",
      phone: "+5511999999999", externalId: "incoming-1", body: "relatório",
      direction: "inbound", authenticated: true,
    });
    expect(intercepted).toBe(false);
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("isola a mensagem do número cadastrado quando falta assinatura, sem gravar consulta", async () => {
    const db = scopedAdmin("org-a", "session-a");
    const intercepted = await interceptManagementMessage(db.admin, {
      organizationId: "org-a", channelSessionId: "session-a",
      phone: "+5511999999999", externalId: "incoming-2", body: "quantos leads?",
      direction: "inbound", authenticated: false,
    });
    expect(intercepted).toBe(true);
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("não permite que outro número ocupe a audiência gerencial", async () => {
    const db = scopedAdmin("org-a", "session-a");
    const intercepted = await interceptManagementMessage(db.admin, {
      organizationId: "org-a", channelSessionId: "session-a",
      phone: "+5511888888888", externalId: "incoming-3", body: "relatório",
      direction: "inbound", authenticated: true,
    });
    expect(intercepted).toBe(false);
  });

  it("não guarda o código de confirmação recebido em texto aberto", async () => {
    const saved = vi.fn(async () => ({ error: null }));
    const from = vi.fn((table: string) => {
      const filters: string[] = [];
      const query = {
        select: () => query,
        eq: () => query,
        in: (column: string, values: string[]) => {
          filters.push(`${column}:${values.join(",")}`); return query;
        },
        is: () => query,
        not: () => query,
        maybeSingle: async () => ({ data: table === "management_bindings" ? {
          organization_id: "org-a", channel_session_id: "session-a",
          manager_phone: "+5511999999999", manager_user_id: "manager-a",
          verified_at: null, challenge_hash: null,
        } : filters.includes("role:manager,admin") ? { id: "member-a" } : null, error: null }),
      };
      return { ...query, insert: saved };
    });
    const result = await interceptManagementMessage({ from } as never, {
      organizationId: "org-a", channelSessionId: "session-a",
      phone: "+5511999999999", externalId: "incoming-code",
      body: "123456", direction: "inbound", authenticated: true,
    });
    expect(result).toBe(true);
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({
      body: "[código de confirmação recebido]", kind: "verification",
    }));
  });
});
