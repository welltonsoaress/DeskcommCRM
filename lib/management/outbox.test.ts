import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "test-secret" } }));
import { openVerificationBody } from "./challenge-envelope";
import { enqueueManagementDelivery } from "./outbox";

describe("fila de confirmação de comando", () => {
  it("guarda o texto pendente cifrado até o transporte usar o código", async () => {
    const insert = vi.fn(async (_row: unknown) => ({ error: null }));
    const admin = { from: () => ({ insert }) };
    const body = "Mover negócio. Para executar, responda CONFIRMAR 123456 em até 10 minutos.";
    expect(await enqueueManagementDelivery(admin as never, { organizationId: "org-a",
      channelSessionId: "session-a", kind: "consultation", dedupeKey: "reply:message-a",
      body, sensitiveBody: true })).toBe(true);
    const row = insert.mock.calls[0]![0] as { body: string; body_encrypted: boolean };
    expect(row.body_encrypted).toBe(true);
    expect(row.body).not.toContain("123456");
    expect(openVerificationBody(row.body)).toBe(body);
  });
});
