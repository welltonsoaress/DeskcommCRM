# Disponibilizar a distribuição Striva Sales

Este roteiro libera a distribuição independente para instalações. O repositório
foi renomeado para `welltonsoaress/striva-sales` e sua descrição foi atualizada.
Esta implementação ainda precisa ser revisada, enviada ao repositório e passar
pelos workflows; nenhuma release ou imagem Striva foi publicada como parte
deste trabalho local.

## 1. Preparar o repositório

1. Confirme que a conta mantenedora tem acesso de escrita e administração a
   `welltonsoaress/striva-sales`. O histórico Git e as issues foram preservados
   pelo rename do GitHub.
2. A descrição já está configurada como: **“Striva Sales — CRM com agentes de
   IA e WhatsApp, multi-organização e hospedagem própria.”**
3. Envie a implementação revisada para a branch principal do repositório.
   Não use o remote antigo como origem de releases nem de tags.
4. Ative proteção da branch principal depois que os workflows rodarem. Confira
   os nomes efetivamente emitidos pelo CI e exija `verify`, `build-and-size`,
   `invariants`, `e2e` e `imagens-ok` quando disponíveis:

   ```bash
   gh api repos/welltonsoaress/striva-sales/branches/main/protection \
     --jq '.required_status_checks.contexts|join(", ")'
   ```

   Não afirme que os checks estão ativos se a consulta falhar ou não os listar.

5. Configure `RELEASE_APP_CLIENT_ID` como variável do repositório e
   `RELEASE_APP_PRIVATE_KEY` como secret do repositório para o GitHub App de
   release. O workflow usa esse App para criar o PR e a tag; não substitua a
   credencial por um `GITHUB_TOKEN` com escrita.

## 2. Migrar instalações existentes

O atualizador que acompanha a versão instalada `v1.19.0` consulta
`ghcr.io/melgarafael/deskcommcrm`, `deskcomm-worker` e
`deskcomm-scheduler`. O repositório renomeado não controla esse namespace,
portanto uma release de transição publicada pelo Striva não consegue corrigir
sozinha o atualizador antigo.

Depois de publicar `striva-v1.0.0` e tornar públicas as três imagens, use o
bootstrap independente do kit para migrar uma cópia ensaiada da instalação
legada. Ele valida a release no repositório próprio, confere os metadados OCI e
baixa as três imagens antes do backup, checkout ou reinício:

```bash
cd /caminho/da/instalacao
curl -fsSLo /tmp/migrar-distribuicao.sh \\
  https://raw.githubusercontent.com/welltonsoaress/striva-sales/striva-v1.0.0/hostgator-setup-kit/migrar-distribuicao.sh
bash /tmp/migrar-distribuicao.sh "$PWD" striva-v1.0.0
```

O script exige que app, worker e scheduler estejam saudáveis; preserva a
identidade Compose, cria backup do banco e das sessões do WhatsApp e tenta
restaurar as imagens anteriores se a atualização ou a verificação final falhar.
Se a release ou qualquer imagem não existir ou não corresponder ao commit,
nenhum código, banco ou serviço é alterado. Faça o ensaio em cópia isolada; não
use uma VPS de cliente como primeiro teste.

Ensaie a atualização e o rollback numa cópia de instalação antiga, incluindo
`.env` com IDs de imagem locais, digest, serviços em versões diferentes e
instalação manual posterior da mesma versão. Não use uma VPS de cliente como
ambiente de ensaio.

## 3. Publicar `striva-v1.0.0`

1. Revise o fragmento `.changes/initial-striva-sales.md` e confirme que o
   changelog só contém notas da identidade Striva.
2. Rode os gates de CI. A release é criada em rascunho por
   `.github/workflows/release.yml`; o workflow de publicação constrói as três
   imagens do mesmo commit.
3. Confira a tag exata `striva-v1.0.0` e confirme que o app, worker e scheduler
   estão públicos no GHCR com tag `1.0.0`:

   - `ghcr.io/welltonsoaress/striva-sales:1.0.0`
   - `ghcr.io/welltonsoaress/striva-worker:1.0.0`
   - `ghcr.io/welltonsoaress/striva-scheduler:1.0.0`

4. Confirme os manifests dos três pacotes e a versão/revisão OCI antes de
   publicar a release. Se uma imagem faltar, mantenha o rascunho e corrija o
   pipeline. Não faça build na VPS.
5. Só depois das verificações, publique a release. Rode instalação fresca e
   atualização de uma cópia legada e confira `/api/v1/health`, worker,
   scheduler, proxy e os crons.

## 4. Aplicar numa instalação existente

O dono escolhe a janela. Faça backup, confira domínio e acesso SSH, atualize
usando `hostgator-setup-kit/update.sh`, e confira saúde dos serviços e WhatsApp.
Depois da release, a administração da plataforma aplica o padrão Striva em
`/admin/marca`; a operação é auditada e invalida o cache. Marcas configuradas
por organização permanecem intactas.

Para mudar o diretório de uma VPS legada, use o procedimento e o helper em
[`deploy.md`](deploy.md#mudança-de-diretório-de-uma-instalação-legada). A pasta
local do desenvolvimento não altera caminhos de VPS.
