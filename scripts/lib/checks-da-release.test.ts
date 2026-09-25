import { describe, expect, it } from "vitest";

import { estadoDoWorkflow, type WorkflowRun } from "./checks-da-release";

const SHA = "a".repeat(40);
const run = (patch: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1, head_sha: SHA, head_branch: "main", event: "push",
  status: "completed", conclusion: "success", ...patch,
});

describe("release só usa validações do commit publicado", () => {
  it("aguarda os três workflows e rejeita ausência ou execução ainda em curso", () => {
    expect(estadoDoWorkflow([], SHA)).toBe("pendente");
    expect(estadoDoWorkflow([run({ status: "in_progress", conclusion: null })], SHA)).toBe("pendente");
  });

  it("não aceita verde de PR, outra branch ou outro commit", () => {
    expect(estadoDoWorkflow([run({ event: "pull_request" })], SHA)).toBe("pendente");
    expect(estadoDoWorkflow([run({ head_branch: "release/2.0.0" })], SHA)).toBe("pendente");
    expect(estadoDoWorkflow([run({ head_sha: "b".repeat(40) })], SHA)).toBe("pendente");
  });

  it("falha fechado para qualquer conclusão que não seja sucesso", () => {
    for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "neutral"])
      expect(estadoDoWorkflow([run({ conclusion })], SHA)).toBe("reprovado");
  });

  it("usa a tentativa mais recente do workflow", () => {
    expect(estadoDoWorkflow([run({ id: 1, conclusion: "failure" }), run({ id: 2 })], SHA)).toBe("aprovado");
    expect(estadoDoWorkflow([run({ id: 2, conclusion: "failure" }), run({ id: 1 })], SHA)).toBe("reprovado");
  });
});
