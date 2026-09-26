# Atualizando o Striva Sales na sua VPS

O Striva Sales verifica releases próprias (`striva-vX.Y.Z`) e só libera a ação para
quem administra a plataforma. Administradores das organizações e demais usuários
veem a versão instalada, mas não recebem o aviso nem podem iniciar a atualização.
Não existe atualização automática.

## O que fazer

Atualizar reinicia o sistema compartilhado por **todas as organizações desta
instalação**. Escolha uma janela adequada. Pela tela, a administração da plataforma
confirma a operação e o sistema cria o backup antes de alterar o banco ou recriar os
serviços. Se precisar operar por SSH, use a pasta do projeto:

```bash
bash hostgator-setup-kit/update.sh
```

O processo leva alguns minutos. A operação só conclui depois que os serviços voltam
saudáveis. Se o registro não responder ou faltar uma das três imagens da release,
a atualização para antes de mexer no banco e nos serviços. Se já estiver na versão
mais recente, nenhuma alteração é feita.

## O que o comando faz (por baixo)

1. Confere se há uma release Striva própria mais nova e se app, worker e scheduler
   estão publicados na mesma versão.
2. Baixa e valida as três imagens antes de alterar a instalação.
3. Faz o backup, baixa o código da tag exata e aplica o baseline idempotente.
4. Reinicia os serviços e só declara sucesso depois da verificação de saúde.

## Coisas normais que você pode ver (não se assuste)

- **Um monte de linhas com "already exists" / "multiple primary keys"** durante a parte
  do banco: **é esperado e inofensivo** — são coisas que já existiam. O comando filtra
  esse ruído e, se estiver tudo certo, mostra **`✓ banco atualizado`**.
- Se aparecer **`⚠ avisos que não são os esperados`**, aí sim vale prestar atenção: o app
  provavelmente ainda funciona, mas guarde a mensagem. Em último caso, dá pra voltar ao
  estado anterior com o backup: `bash hostgator-setup-kit/restore.sh`.

## Dicas

- **Quando atualizar?** Depois do aviso de release, na janela escolhida pela
  administração da plataforma. A checagem periódica não atualiza nada sozinha.
- **Deu algo estranho?** Rode `bash hostgator-setup-kit/healthcheck.sh` pra ver o estado
  de tudo de uma vez.
