/** Resolve a base numérica do changelog sem confundir um seed técnico com release. */
export function versaoBase(changelog: string): string {
  for (const linha of changelog.split("\n")) {
    const secao = /^##\s+\[(\d+\.\d+\.\d+)\]/.exec(linha);
    if (secao?.[1]) return secao[1];
  }

  // A primeira release da distribuição não tem seção histórica para comparar.
  // O comentário HTML é um seed de cálculo, não uma versão publicada na tela.
  const seed = /^<!--\s*release-base:\s*(\d+\.\d+\.\d+)\s*-->\s*$/m.exec(changelog);
  if (seed?.[1]) return seed[1];

  throw new Error("CHANGELOG.md sem seção de release ou metadado `release-base`");
}
