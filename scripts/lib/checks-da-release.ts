export interface WorkflowRun {
  id: number;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
}

export type EstadoDoCheck = "aprovado" | "pendente" | "reprovado";

/** Só uma execução de push na main para o commit exato autoriza uma tag. */
export function estadoDoWorkflow(runs: WorkflowRun[], sha: string): EstadoDoCheck {
  const execucao = runs
    .filter((run) => run.head_sha === sha && run.head_branch === "main" && run.event === "push")
    .sort((a, b) => b.id - a.id)[0];
  if (!execucao || execucao.status !== "completed") return "pendente";
  return execucao.conclusion === "success" ? "aprovado" : "reprovado";
}
