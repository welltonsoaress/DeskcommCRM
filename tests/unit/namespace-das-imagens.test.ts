import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
const contract = Object.fromEntries(
  read("hostgator-setup-kit/distribution.env")
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z_]+)="([^"]*)"$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => [m[1]!, m[2]!]),
);
const imageNames = [
  contract.DISTRIBUTION_APP_IMAGE,
  contract.DISTRIBUTION_WORKER_IMAGE,
  contract.DISTRIBUTION_SCHEDULER_IMAGE,
] as const;
const namespace = `${contract.DISTRIBUTION_REGISTRY}/${contract.DISTRIBUTION_IMAGE_OWNER}`;

describe("contrato independente da distribuição Striva Sales", () => {
  it("ancora identidade, repositório e tags no projeto próprio", () => {
    expect(contract.DISTRIBUTION_ID).toBe("striva-sales");
    expect(contract.DISTRIBUTION_REPOSITORY).toBe("welltonsoaress/striva-sales");
    expect(contract.DISTRIBUTION_RELEASE_TAG_PREFIX).toBe("striva-v");
    expect(contract.DISTRIBUTION_DEFAULT_BRANCH).toBe("main");
    const source = read("lib/system/distribution.ts");
    expect(source).toContain(`"${contract.DISTRIBUTION_ID}"`);
    expect(source).toContain(`"${contract.DISTRIBUTION_REPOSITORY}"`);
    expect(source).toContain(`"${contract.DISTRIBUTION_RELEASE_TAG_PREFIX}"`);
  });

  it("declara três nomes únicos de imagem e os deriva no kit", () => {
    expect(new Set(imageNames).size).toBe(3);
    const common = read("hostgator-setup-kit/_common.sh");
    expect(common).toContain('source "$(dirname "${BASH_SOURCE[0]}")/distribution.env"');
    expect(common).toContain('IMG_NS="${DISTRIBUTION_REGISTRY}/${DISTRIBUTION_IMAGE_OWNER}"');
    expect(common).toContain('IMG_APP="${IMG_NS}/${DISTRIBUTION_APP_IMAGE}"');
    expect(common).toContain('IMG_WORKER="${IMG_NS}/${DISTRIBUTION_WORKER_IMAGE}"');
    expect(common).toContain('IMG_SCHEDULER="${IMG_NS}/${DISTRIBUTION_SCHEDULER_IMAGE}"');
  });

  it.each([
    ["APP_IMAGE", imageNames[0]],
    ["WORKER_IMAGE", imageNames[1]],
    ["SCHEDULER_IMAGE", imageNames[2]],
  ] as const)("compose e template usam o pacote próprio %s", (key, image) => {
    const ref = `${namespace}/${image}:1.0.0`;
    expect(read("docker-compose.prod.yml")).toContain(`image: ${"${"}${key}:-${ref}}`);
    expect(read(".env.hostgator.example")).toContain(`${key}=${ref}`);
  });

  it("workflows publicam somente tags Striva e as três imagens do contrato", () => {
    const publish = read(".github/workflows/publish-image.yml");
    const release = read(".github/workflows/release.yml");
    const workflowImages = [...publish.matchAll(/^\s+- name: (striva-[^\s]+)$/gm)].map((m) => m[1]);
    expect(workflowImages.sort()).toEqual([...imageNames].sort());
    expect(publish).toContain('tags: ["striva-v*"]');
    expect(release).toContain("striva-v${VERSAO}");
    expect(publish).toContain("${{ github.repository_owner }}/${{ matrix.name }}");
  });

  it("instalador, atualizador e Dockerfiles não apontam ao repositório herdado", () => {
    const repoUrl = `https://github.com/${contract.DISTRIBUTION_REPOSITORY}.git`;
    const install = read("hostgator-setup-kit/install.sh");
    expect(install).toContain("${DISTRIBUTION_REPOSITORY}.git");
    expect(read("hostgator-setup-kit/comecar.sh")).toContain(`https://github.com/${contract.DISTRIBUTION_REPOSITORY}.git`);
    expect(read("hostgator-setup-kit/_common.sh")).toContain("DISTRIBUTION_GIT_URL");
    for (const file of ["Dockerfile", "Dockerfile.worker", "Dockerfile.scheduler"]) {
      expect(read(file)).toContain(`org.opencontainers.image.source="https://github.com/${contract.DISTRIBUTION_REPOSITORY}"`);
    }
    expect(read("hostgator-setup-kit/distribution.env")).toContain(`DISTRIBUTION_REPOSITORY="${contract.DISTRIBUTION_REPOSITORY}"`);
    expect(repoUrl).not.toContain("melgarafael");
  });
});
