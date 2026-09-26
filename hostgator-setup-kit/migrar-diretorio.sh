#!/usr/bin/env bash
# Migra uma instalação existente para uma pasta `striva-sales` sem trocar a
# identidade Compose nem deixar os crons do kit apontando para o caminho antigo.
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$KIT_DIR/_common.sh"

cron_reescrever_diretorio() { # cron_reescrever_diretorio <origem> <destino> <url> <secret>
  local antiga="$1" nova="$2" url="$3" secret="$4" linha marcador papel
  local drain_novo="# deskcomm:${nova}:drain" agent_novo="# deskcomm:${nova}:agent"
  local drain_visto=0 agent_visto=0
  while IFS= read -r linha || [ -n "$linha" ]; do
    papel=""
    case "$linha" in
      *"# deskcomm:${antiga}:drain"*) papel=drain ;;
      *"# deskcomm:${antiga}:agent"*) papel=agent ;;
      *"cd ${antiga} && bash hostgator-setup-kit/agent.sh"*) papel=agent ;;
      *)
        # Adota somente a linha legada que tem simultaneamente a URL e o
        # segredo desta instalação. Não remove a tarefa de outro CRM no host.
        if [ -n "$url" ] && [ -n "$secret" ] \
          && [[ "$linha" == *"${url}/api/v1/cron/event-log-drain"* ]] \
          && [[ "$linha" == *"Bearer ${secret}"* ]]; then papel=drain; fi
        ;;
    esac

    if [ -n "$papel" ]; then
      linha="${linha//"$antiga"/"$nova"}"
      case "$papel" in
        drain)
          [[ "$linha" == *"$drain_novo"* ]] || linha="${linha} ${drain_novo}"
          [ "$drain_visto" = 0 ] || continue
          drain_visto=1
          ;;
        agent)
          [[ "$linha" == *"$agent_novo"* ]] || linha="${linha} ${agent_novo}"
          [ "$agent_visto" = 0 ] || continue
          agent_visto=1
          ;;
      esac
    fi
    printf '%s\n' "$linha"
  done
}

if [ "${MIGRAR_DIRETORIO_LIB:-0}" = 1 ]; then
  return 0 2>/dev/null || exit 0
fi

if [ "$#" -ne 1 ]; then
  printf 'Uso: bash hostgator-setup-kit/migrar-diretorio.sh /caminho/striva-sales\n' >&2
  exit 2
fi

ORIGEM="$(cd "$KIT_DIR/.." && pwd -P)"
DESTINO_ARG="$1"
DESTINO_PAI="$(dirname "$DESTINO_ARG")"
[ -d "$DESTINO_PAI" ] || die "A pasta de destino precisa ter um pai já existente: $DESTINO_PAI"
DESTINO_PAI="$(cd "$DESTINO_PAI" && pwd -P)"
DESTINO="${DESTINO_PAI}/$(basename "$DESTINO_ARG")"
[ "$(basename "$DESTINO")" = striva-sales ] || die "O nome de destino precisa ser exatamente striva-sales."
case "$DESTINO" in *[[:space:]]*|*:*|*$'\n'*) die "O caminho novo não pode conter espaços, dois-pontos ou quebras de linha, pois também será usado no crontab." ;; esac
[ "$ORIGEM" != "$DESTINO" ] || die "A instalação já está nesse caminho."
[ ! -e "$DESTINO" ] || die "O destino já existe; não vou mesclar nem sobrescrever arquivos: $DESTINO"
[ -f "$ORIGEM/.env" ] && [ -f "$ORIGEM/$COMPOSE" ] || die "Rode este comando dentro de uma instalação completa, com .env e $COMPOSE."

# Evita mover uma instalação enquanto o agente estiver atualizando os serviços.
exec 9>"$ORIGEM/.update.lock"
flock -n 9 || die "Há uma atualização em andamento. Aguarde o agente terminar e tente novamente."

load_env "$ORIGEM/.env"
NOME_CONFIGURADO=""
if grep -qE '^COMPOSE_PROJECT_NAME=' "$ORIGEM/.env"; then
  NOME_CONFIGURADO="${COMPOSE_PROJECT_NAME:-}"
fi

# Se o .env antigo ainda não fixava o projeto, leia a identidade real dos
# contêineres. Se Docker não responder, falha fechada em vez de adivinhar e
# criar um segundo conjunto de volumes/redes após o move.
if ! command -v docker >/dev/null 2>&1; then die "Docker é necessário para confirmar o nome Compose da instalação antiga."; fi
if ! PROJETOS="$(docker ps -a --filter "label=com.docker.compose.project.working_dir=${ORIGEM}" --format '{{.Label "com.docker.compose.project"}}')"; then
  die "Não consegui consultar os contêineres Docker. Inicie o daemon e repita; nenhum arquivo foi movido."
fi
PROJETOS="$(printf '%s\n' "$PROJETOS" | sed '/^$/d' | sort -u)"
[ "$(printf '%s\n' "$PROJETOS" | sed '/^$/d' | wc -l | tr -d ' ')" -le 1 ] || die "Os contêineres desta pasta declaram mais de um projeto Compose; resolva a inconsistência antes de mover."
NOME_OBSERVADO="$(printf '%s\n' "$PROJETOS" | sed -n '1p')"
if [ -n "$NOME_CONFIGURADO" ] && [ -n "$NOME_OBSERVADO" ] && [ "$NOME_CONFIGURADO" != "$NOME_OBSERVADO" ]; then
  die "COMPOSE_PROJECT_NAME no .env ($NOME_CONFIGURADO) diverge dos contêineres ($NOME_OBSERVADO); migração cancelada."
fi
NOME_COMPOSE="${NOME_CONFIGURADO:-${NOME_OBSERVADO:-$(nome_do_projeto_compose "$ORIGEM")}}"
[ -n "$NOME_COMPOSE" ] || die "Não consegui determinar COMPOSE_PROJECT_NAME com segurança."

URL_DRAIN="${NEXT_PUBLIC_APP_URL:-}"
SEGREDO_CRON="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
if [ -n "$URL_DRAIN" ]; then URL_DRAIN="${URL_DRAIN%/}"; fi

CRON_ANTES="$(mktemp)"
CRON_DEPOIS="$(mktemp)"
CRON_INSTALADO=0
MOVIDO=0
limpar_temporarios() { rm -f "$CRON_ANTES" "$CRON_DEPOIS"; }
trap limpar_temporarios EXIT
if ! crontab -l >"$CRON_ANTES" 2>/dev/null; then : >"$CRON_ANTES"; fi
cron_reescrever_diretorio "$ORIGEM" "$DESTINO" "$URL_DRAIN" "$SEGREDO_CRON" <"$CRON_ANTES" >"$CRON_DEPOIS"

# Fixar o nome antes do move garante que o próximo `docker compose up` continue
# usando os mesmos contêineres, volumes e redes. O arquivo tem segredos: helper
# mantém modo 0600 como o resto do kit.
set_env_var "$ORIGEM/.env" COMPOSE_PROJECT_NAME "$NOME_COMPOSE"
mv -- "$ORIGEM" "$DESTINO"
MOVIDO=1

if crontab "$CRON_DEPOIS"; then
  CRON_INSTALADO=1
else
  # Se não foi possível instalar as novas linhas, restaura o crontab original e
  # devolve a pasta ao lugar. O nome Compose continua pinado com o valor antigo.
  crontab "$CRON_ANTES" || true
  mv -- "$DESTINO" "$ORIGEM" || true
  MOVIDO=0
  die "Não consegui atualizar o crontab; restaurei a pasta ao caminho anterior."
fi

printf '✓ instalação movida para %s\n' "$DESTINO"
printf '✓ COMPOSE_PROJECT_NAME preservado como %s; volumes, redes e sessões mantêm a identidade.\n' "$NOME_COMPOSE"
printf '✓ crons desta instalação atualizados e deduplicados; crons de outras pastas preservados.\n'
printf '\nPróximo passo: cd %q && bash hostgator-setup-kit/healthcheck.sh\n' "$DESTINO"
