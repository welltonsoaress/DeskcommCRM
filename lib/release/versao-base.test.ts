import { describe, expect, it } from "vitest";

import { versaoBase } from "./versao-base";

describe("versaoBase", () => {
  it("usa o seed de distribuição sem exibir uma versão técnica como release", () => {
    const changelog = "# Changelog\n\n## [Não lançado]\n\n<!-- release-base: 0.0.0 -->\n";
    expect(versaoBase(changelog)).toBe("0.0.0");
  });

  it("calcula a primeira major própria como 1.0.0", async () => {
    const { proximaVersao } = await import("./fragmento");
    expect(proximaVersao(versaoBase("<!-- release-base: 0.0.0 -->"), "major")).toBe("1.0.0");
  });

  it("prefere a seção publicada e ignora o seed depois do primeiro corte", () => {
    const changelog = "# Changelog\n\n## [1.0.0] — Primeira release\n\n<!-- release-base: 0.0.0 -->\n";
    expect(versaoBase(changelog)).toBe("1.0.0");
  });

  it("recusa changelog sem release e sem seed", () => {
    expect(() => versaoBase("# Changelog\n\n## [Não lançado]\n")).toThrow(/release-base/);
  });
});
