/** Identidade técnica da distribuição publicada em releases próprias. */
export const DISTRIBUTION_ID = "striva-sales" as const;
export const DISTRIBUTION_REPOSITORY = "welltonsoaress/striva-sales" as const;
export const DISTRIBUTION_TAG_PREFIX = "striva-v" as const;

export function distributionTag(version: string): string {
  return `${DISTRIBUTION_TAG_PREFIX}${version}`;
}

/** Identidade incompleta ou homônima nunca valida uma release para a UI/POST. */
export function releaseDaDistribuicaoVerificada(input: {
  version: string | null | undefined;
  repository: string | null | undefined;
  tag: string | null | undefined;
  commit: string | null | undefined;
}): boolean {
  const { version, repository, tag, commit } = input;
  if (repository !== DISTRIBUTION_REPOSITORY || !version) return false;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  if (tag !== distributionTag(version)) return false;
  return typeof commit === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit);
}
