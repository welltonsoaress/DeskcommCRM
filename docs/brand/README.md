# Identidade visual do Striva Sales

## Arquivos de marca

| Arquivo | Uso |
|---|---|
| `striva-sales-light.svg` | Logotipo completo para fundos claros. |
| `striva-sales-dark.svg` | Logotipo completo para fundos escuros. |
| `striva-sales-monochrome.svg` | Logotipo de uma cor para aplicações especiais. |
| `striva-symbol.svg` | Símbolo S geométrico isolado com módulo destacado. |
| `og-card.html` / `og-social-preview.png` | Cartão de compartilhamento do repositório. |

As letras do SVG são caminhos, sem dependência de fonte. A geometria usada pelo
aplicativo está compartilhada em `lib/branding/desenho.ts`, `components/branding/MarcaDoProduto.tsx`
e `app/icon.tsx`. Mantenha essas formas sincronizadas com os SVGs.

O app não serve o arquivo padrão como marca universal. O resolvedor segue a
precedência de marca da organização, instalação e ambiente antes do padrão
Striva Sales. Isso mantém o white-label para revendedores. O teste
`tests/unit/branding.test.ts` protege a fronteira entre código de interface e
marcas personalizadas.

## Paleta

O violeta-base é `#7C3AED`; a escala completa para temas claro e escuro está em
`app/globals.css`. As cores semânticas de sucesso, atenção e erro continuam com
seus significados próprios. `app/design/lib/tokens.ts` apresenta a mesma escala
no showcase de design.

## Cartão social

`og-card.html` é a fonte do PNG 1280×640. Para regenerá-lo após uma mudança:

```bash
node -e '
import("@playwright/test").then(async ({ chromium }) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await page.goto("file://" + process.cwd() + "/docs/brand/og-card.html", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: "docs/brand/og-social-preview.png" });
  await browser.close();
});'
```

O envio do cartão social ao GitHub é feito em **Settings → General → Social preview**.
