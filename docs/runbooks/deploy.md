# Runbook — atualização e deploy do Striva Sales

A VPS recebe imagens publicadas pelo CI. Ela não compila o app, worker ou
scheduler. Uma release só pode ser liberada depois de as três imagens da mesma
versão estarem disponíveis no GHCR.

## Atualizar uma instalação

Somente a administração da plataforma pode iniciar a atualização, pela interface
ou por SSH. A mudança reinicia os serviços compartilhados por todas as
organizações daquela instalação, então o dono escolhe a janela e confirma a
operação. Não existe atualização automática.

Antes de operar, faça o backup e confirme a release/tag e os três manifests no
GHCR. O script baixa e valida o trio antes de alterar o banco ou recriar os
serviços:

```bash
cd /caminho/da/instalacao
bash hostgator-setup-kit/backup.sh
bash hostgator-setup-kit/update.sh
bash hostgator-setup-kit/healthcheck.sh
```

Em VPS com proxy externo, o kit inclui `docker-compose.traefik.yml` no comando
de subida. Se precisar operar Compose manualmente, passe os dois arquivos:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml \
  --env-file .env up -d app worker scheduler
```

Sem proxy externo, use apenas `docker-compose.prod.yml`. Confira depois o
endpoint `/api/v1/health`, a saúde dos três serviços, o roteamento do domínio e
a conexão do WhatsApp. Uma falha de pull interrompe o update antes do banco;
não a contorne com build local na VPS.

## Mudança de diretório de uma instalação legada

Instalações já existentes podem estar em uma pasta chamada `DeskcommCRM`. O
renomeio precisa preservar o `COMPOSE_PROJECT_NAME`, pois ele identifica os
contêineres, volumes e redes. O helper também move os crons do kit para o novo
caminho e remove duplicatas daquela instalação sem apagar as tarefas de outras
pastas.

Faça backup e escolha uma janela sem atualização em andamento. Confirme que o
volume de destino tem espaço e que `/caminho/striva-sales` ainda não existe.
Rode o script **a partir da instalação antiga** como o mesmo usuário que possui
os crons:

```bash
bash hostgator-setup-kit/migrar-diretorio.sh /caminho/striva-sales
cd /caminho/striva-sales
bash hostgator-setup-kit/healthcheck.sh
```

O helper falha se o destino existir, se o Docker não permitir identificar o
projeto ou se uma atualização estiver usando o lock. Ele grava o nome Compose
antigo antes do move. Backups contidos na pasta acompanham a mudança; volumes e
redes com nome derivado do Compose mantêm o nome. Montagens e unidades systemd
criadas manualmente fora da pasta não são administradas pelo kit: atualize os
caminhos delas e confira o proxy da hospedagem antes de reiniciar qualquer
serviço. Não remova a cópia antiga até validar domínio, sessões WhatsApp e
agendamentos no destino.

## Nova distribuição

O contrato próprio é `welltonsoaress/striva-sales`, tags `striva-vX.Y.Z` e
imagens `striva-sales`, `striva-worker` e `striva-scheduler`. Confira o estado do
repositório, os checks e a publicação em
[`ativar-packaging.md`](ativar-packaging.md) antes de anunciar uma release.

### Primeira migração de uma instalação antiga

A versão legada pode apontar para imagens sob o namespace do projeto original.
Depois que a primeira release Striva e os três pacotes estiverem publicados, o
operador da instalação deve executar, numa janela escolhida por ele, o
bootstrap `hostgator-setup-kit/migrar-distribuicao.sh`. O procedimento exato,
incluindo a validação prévia em uma cópia da instalação, está em
[ativar-packaging.md](ativar-packaging.md#migrar-instalações-existentes).

O bootstrap mantém o diretório e o nome do projeto Docker atuais. Só depois de
confirmar a saúde da instalação a pasta pode ser migrada separadamente com
`migrar-diretorio.sh`. Não rode a ponte em produção até validar o backup e o
rollback numa cópia legada.
