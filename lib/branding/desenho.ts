/** Geometria vetorial compartilhada pelo logo do produto e pelo favicon. */
export type Glifo = { readonly transform: string; readonly d: string };

/** S geométrico em fita contínua, com um módulo quadrado separado. */
export const SIMBOLO = {
  viewBox: "0 0 100 110",
  transform: "translate(0 0)",
  d: "M94 8H48C29 8 18 19 18 36c0 15 10 24 28 29l20 6c7 2 10 5 10 10 0 6-5 9-14 9H18v14h45c20 0 31-11 31-28 0-14-8-23-26-29l-20-6c-7-2-10-5-10-10 0-6 4-9 12-9h44Z",
  modulo: { x: 3, y: 3, width: 12, height: 12, rx: 3 },
} as const;

/** Palavra vetorial desenhada em paths; não depende de fontes instaladas. */
export const LOGOTIPO = {
  viewBox: "0 0 420 110",
  simbolo: {
    transform: "translate(4 2) scale(0.84)",
    d: SIMBOLO.d,
    modulo: SIMBOLO.modulo,
  },
  nome: [
    { transform: "translate(108 22)", d: "M34 4H15C7 4 3 9 3 16c0 7 5 10 13 12l9 2c6 1 9 4 9 9 0 6-5 9-12 9H3" },
    { transform: "translate(151 22)", d: "M3 4H37M20 4V48" },
    { transform: "translate(197 22)", d: "M3 48V4h20c9 0 14 5 14 12s-5 12-14 12H3m18 0 17 20" },
    { transform: "translate(245 22)", d: "M4 4V48" },
    { transform: "translate(263 22)", d: "M3 4 20 48 37 4" },
    { transform: "translate(309 22)", d: "M3 48 20 4l17 44M9 33h22" },
  ] as readonly Glifo[],
  sufixo: [
    { transform: "translate(110 83)", d: "M12 2H5C2 2 1 4 1 6c0 3 2 4 5 5l3 1c3 1 4 2 4 4 0 3-2 4-5 4H1" },
    { transform: "translate(129 83)", d: "M1 20 8 2l7 18M4 14h8" },
    { transform: "translate(150 83)", d: "M2 2v18h13" },
    { transform: "translate(169 83)", d: "M14 2H2v18h12M2 11h10" },
    { transform: "translate(190 83)", d: "M12 2H5C2 2 1 4 1 6c0 3 2 4 5 5l3 1c3 1 4 2 4 4 0 3-2 4-5 4H1" },
  ] as readonly Glifo[],
} as const;

/** Cores do logo nos temas claro e escuro, sincronizadas com os tokens. */
export const CORES_DA_MARCA = {
  claro: { simbolo: "#7c3aed", modulo: "#a78bfa", nome: "#1c1a16", sufixo: "#5d594f" },
  escuro: { simbolo: "#a78bfa", modulo: "#7c3aed", nome: "#f5f4ef", sufixo: "#8e8b7f" },
} as const;
