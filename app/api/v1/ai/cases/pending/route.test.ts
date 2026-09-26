import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const rows = [
  {
    id: "case-1",
    opened_at: "2026-09-25T12:00:00.000Z",
    awaiting_human_at: "2026-09-25T12:05:00.000Z",
  },
];

let filters: Array<[string, unknown]>;
let readError: { message: string } | null;

beforeEach(() => {
  vi.clearAllMocks();
  filters = [];
  readError = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => ({
      select: (columns: string) => {
        expect(table).toBe("agent_cases");
        expect(columns).toBe("id, opened_at, awaiting_human_at");
        return {
          eq: (column: string, value: unknown) => {
            filters.push([column, value]);
            return {
              eq: (nextColumn: string, nextValue: unknown) => {
                filters.push([nextColumn, nextValue]);
                return {
                  order: async () => ({ data: rows, error: readError }),
                };
              },
            };
          },
        };
      },
    }),
  } as never);
});

describe("GET /api/v1/ai/cases/pending", () => {
  it("exige papel de agent e filtra por organização e awaiting_human", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "agent_cases_pending" }));
    expect(filters).toEqual([
      ["organization_id", ORG_ID],
      ["status", "awaiting_human"],
    ]);
    expect(body.data).toEqual({ pending_cases: rows, pending_count: 1 });
    expect(JSON.stringify(body)).not.toMatch(/phone|contact|summary|body/i);
  });

  it("falha de leitura não vira contagem zero", async () => {
    readError = { message: "conexão caiu" };
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(500);
  });

  it("devolve a recusa da autorização sem consultar casos", async () => {
    const denied = new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 });
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: denied } as never);
    const { GET } = await import("./route");
    expect((await GET()).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
