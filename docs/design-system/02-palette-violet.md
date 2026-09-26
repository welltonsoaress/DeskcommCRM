# 02 — Paleta Violeta Striva

> **Fonte dos tokens:** `app/design/lib/tokens.ts` → `PALETTES.striva` e
> `app/globals.css`. O padrão de instalação usa `#7C3AED`; organizações
> podem manter sua própria cor por meio do branding white-label.

## Direção

O violeta Striva dá identidade à interface sem transformar toda a tela em uma
superfície saturada. O acento é aplicado em ações, links, foco e estados ativos.
As superfícies continuam greige e as cores semânticas de sucesso, atenção, erro e
informação continuam independentes do roxo.

Os temas claro e escuro são calibrados separadamente. O tema escuro não é uma
inversão mecânica do claro. Marcas personalizadas de instalação e de organização
seguem a cascata definida em [marca própria](../white-label.md), sem serem
substituídas pela paleta Striva.

## Acento — Violeta Striva

| Stop | Hex | Uso |
|---|---|---|
| 50 | `#F5F3FF` | Fundo discreto e hover suave |
| 100 | `#EAE6FF` | Acento suave para badge, navegação e foco |
| 200 | `#D5CCFF` | Bordas secundárias |
| 300 | `#BBA8FF` | Estado desabilitado ou divisores |
| 400 | `#A384FF` | Acento luminoso em tema escuro |
| 500 | `#915FFF` | Hover luminoso e foco |
| 600 | `#7C3AED` | Acento principal e botão primário no tema claro |
| 700 | `#6133B8` | Hover/pressed e texto sobre fundo claro |
| 800 | `#4E2D91` | Texto em superfícies de acento suave |
| 900 | `#412976` | Uso de alto contraste |
| 950 | `#1F113E` | Uso extremo; não aplicar em áreas grandes |

O tema escuro usa um tom mais luminoso para ações e links, conforme os aliases
em `app/globals.css`. Prefira os tokens `--color-accent`,
`--color-accent-soft` e `--color-accent-hover` em vez de fixar hex
em componentes.

## Superfícies e estados

O violeta não altera os neutros nem as cores semânticas. Os valores completos de
superfícies, tipografia, bordas e estados estão no CSS canônico e em
`PALETTES.striva`:

- Light: fundo `#FAF9F6`, surface branca, texto `#1C1A16`.
- Dark: fundo `#161510`, surface `#1D1C17`, texto `#F5F4EF`.
- Sucesso, atenção, erro e informação mantêm tokens próprios e não recebem matiz
  automaticamente do branding.

Não escolha uma cor semântica para combinar com o acento. Mensagens de sucesso,
atenção e falha devem continuar distinguíveis por rótulo e ícone, além da cor.

## Uso e acessibilidade

- Aplique o acento em ação primária, link, foco e navegação ativa; sidebar inteira
  e áreas extensas permanecem neutras.
- Não use gradiente violeta como decoração. A profundidade vem da hierarquia de
  superfície, borda e sombra já definidas pelos tokens.
- Componentes novos devem consumir os aliases de CSS e respeitar os temas claro e
  escuro.
- Mudanças na rampa precisam passar pela régua de contraste gerada e pelo teste
  `tests/unit/branding-contraste.test.ts`; não declare conformidade por
  inspeção visual.
- O onboarding e a administração podem configurar cores próprias. A paleta Striva
  só é o fallback da marca da instalação.

## Registro

- **Violeta Striva** — identidade padrão introduzida com a distribuição própria.
- A paleta Sage é material histórico e não representa os tokens atuais.
