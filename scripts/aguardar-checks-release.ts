import { z } from "zod";

import { estadoDoWorkflow, type WorkflowRun } from "./lib/checks-da-release";

const RESPOSTA = z.object({ workflow_runs: z.array(z.object({
  id: z.number(), head_sha: z.string(), head_branch: z.string().nullable(),
  event: z.string(), status: z.string(), conclusion: z.string().nullable(),
})) });
const WORKFLOWS = ["ci.yml", "e2e.yml", "perf.yml"] as const;
const INTERVALO_MS = 30_000;
const TENTATIVAS = 90; // até 45 minutos; E2E tem teto de 30 minutos mais fila.

async function execucoesDoWorkflow(repo: string, arquivo: string, sha: string, token: string): Promise<WorkflowRun[]> {
  const query = new URLSearchParams({ head_sha: sha, event: "push", branch: "main", per_page: "100" });
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${arquivo}/runs?${query}`;
  const resposta = await fetch(url, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resposta.ok) throw new Error(`GitHub não confirmou ${arquivo}: HTTP ${resposta.status}`);
  return RESPOSTA.parse(await resposta.json()).workflow_runs;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const sha = process.env.GITHUB_SHA ?? "";
  const token = process.env.GH_TOKEN ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9a-f]{40}$/i.test(sha) || !token)
    throw new Error("Contexto de release incompleto: repositório, SHA ou token de leitura ausente.");

  let ultimoEstado = "";
  for (let tentativa = 0; tentativa < TENTATIVAS; tentativa++) {
    const estados = await Promise.all(WORKFLOWS.map(async (arquivo) => ({
      arquivo, estado: estadoDoWorkflow(await execucoesDoWorkflow(repo, arquivo, sha, token), sha),
    })));
    const resumo = estados.map(({ arquivo, estado }) => `${arquivo}=${estado}`).join(" ");
    if (resumo !== ultimoEstado) process.stdout.write(`${resumo}\n`);
    ultimoEstado = resumo;
    const reprovados = estados.filter(({ estado }) => estado === "reprovado");
    if (reprovados.length) throw new Error(`Tag recusada: validação falhou neste commit (${resumo}).`);
    if (estados.every(({ estado }) => estado === "aprovado")) return;
    if (tentativa < TENTATIVAS - 1) await new Promise((resolve) => setTimeout(resolve, INTERVALO_MS));
  }
  throw new Error(`Tag recusada: checks não terminaram para ${sha} em 45 minutos (${ultimoEstado}).`);
}

main().catch((error: unknown) => {
  process.stderr.write(`::error::${error instanceof Error ? error.message : "Falha ao conferir checks da release."}\n`);
  process.exitCode = 1;
});
