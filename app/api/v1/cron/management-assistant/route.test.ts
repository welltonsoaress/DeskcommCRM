import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ actions: vi.fn(), replies: vi.fn(), schedule: vi.fn(), delivery: vi.fn(), end: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "test-cron-secret", INTERNAL_SECRET: "", SUPABASE_DB_URL: "" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/agent-engine/db/pool", () => ({ createPool: () => ({ end: mocks.end }) }));
vi.mock("@/lib/management/schedule", () => ({ produceManagementReplies: mocks.replies, produceManagementSchedule: mocks.schedule }));
vi.mock("@/lib/management/delivery", () => ({ drainManagementOutbox: mocks.delivery }));
vi.mock("@/lib/management/actions", () => ({ recoverUncertainManagementActions: mocks.actions }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actions.mockResolvedValue(0);
  mocks.replies.mockResolvedValue(1);
  mocks.schedule.mockResolvedValue({ daily: 0, alerts: 0 });
  mocks.delivery.mockResolvedValue(1);
  mocks.end.mockResolvedValue(undefined);
});

describe("cron da gestão", () => {
  it.each(["replies", "schedule"] as const)("entrega respostas prontas mesmo quando %s falha", async (stage) => {
    mocks[stage].mockRejectedValue(new Error("management_context_unavailable"));
    const response = await GET(new Request("http://localhost/api/v1/cron/management-assistant", {
      headers: { authorization: "Bearer test-cron-secret" },
    }) as NextRequest);
    expect(mocks.delivery).toHaveBeenCalledTimes(1);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { details: { failed_stages: [stage] } } });
  });

  it("continua recusando chamadas sem o segredo", async () => {
    const response = await GET(new Request("http://localhost/api/v1/cron/management-assistant") as NextRequest);
    expect(response.status).toBe(403);
    expect(mocks.replies).not.toHaveBeenCalled();
    expect(mocks.delivery).not.toHaveBeenCalled();
  });
});
