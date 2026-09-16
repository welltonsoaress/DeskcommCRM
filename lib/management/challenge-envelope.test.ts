import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "synthetic-test-key" } }));
import { openVerificationBody, sealVerificationBody } from "./challenge-envelope";

describe("desafio na fila durável", () => {
  it("não mantém o código em texto aberto e detecta alteração do envelope", () => {
    const text = "Confirme o código 908172 no WhatsApp comercial.";
    const sealed = sealVerificationBody(text);
    expect(sealed).not.toContain("908172");
    expect(openVerificationBody(sealed)).toBe(text);
    const index = sealed.length - 12;
    const changed = sealed[index] === "A" ? "B" : "A";
    expect(() => openVerificationBody(`${sealed.slice(0, index)}${changed}${sealed.slice(index + 1)}`)).toThrow();
  });
});
