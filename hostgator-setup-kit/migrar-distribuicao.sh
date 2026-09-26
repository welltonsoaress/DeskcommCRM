#!/usr/bin/env bash
# Ponte única para instalações legadas cujo update.sh ainda busca imagens do
# namespace anterior. Baixa a release própria e valida o trio de imagens antes
# de tocar no checkout, banco ou serviços.
set -euo pipefail

readonly REPOSITORY="welltonsoaress/striva-sales"
readonly REPOSITORY_URL="$(printf 'https://github.com/%s.git' "$REPOSITORY")"
readonly IMAGE_OWNER="ghcr.io/welltonsoaress"
readonly IMAGE_SOURCE="$(printf 'https://github.com/%s' "$REPOSITORY")"

die() { printf '✖ %s\n' "$*" >&2; exit 1; }
info() { printf '→ %s\n' "$*"; }

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf 'Uso: bash migrar-distribuicao.sh /caminho/da/instalacao [striva-v1.0.0]\n' >&2
  exit 2
fi

PROJECT_DIR="$(cd "$1" 2>/dev/null && pwd -P)" || die "Não achei a pasta da instalação: $1"
TARGET_TAG="${2:-striva-v1.0.0}"
[[ "$TARGET_TAG" =~ ^striva-v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "Tag inválida. Use uma release estável no formato striva-vX.Y.Z."

for cmd in curl docker flock git python3; do
  command -v "$cmd" >/dev/null 2>&1 || die "Este servidor precisa do comando '$cmd' para migrar com segurança."
done
[ -f "$PROJECT_DIR/.env" ] \
  && [ -f "$PROJECT_DIR/docker-compose.prod.yml" ] \
  && [ -f "$PROJECT_DIR/hostgator-setup-kit/update.sh" ] \
  || die "A pasta escolhida não parece uma instalação completa do CRM."
[ -d "$PROJECT_DIR/.git" ] || die "A instalação precisa ser um clone Git para receber a release verificada."
[ ! -f "$PROJECT_DIR/hostgator-setup-kit/distribution.env" ] \
  || die "Esta instalação já usa o contrato Striva. Atualize com hostgator-setup-kit/update.sh."

exec 9>"$PROJECT_DIR/.update.lock"
flock -n 9 || die "Já existe uma atualização em andamento. Aguarde e tente novamente."

if [ -n "$(git -C "$PROJECT_DIR" status --porcelain --untracked-files=no)" ]; then
  die "Há alterações locais em arquivos versionados. Revise ou salve-as antes da migração."
fi

VERSION="$(printf '%s' "$TARGET_TAG" | sed 's/^striva-v//')"
RELEASE_JSON="$(curl --fail --silent --show-error --max-time 20 \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPOSITORY/releases/tags/$TARGET_TAG")" \
  || die "Não consegui verificar a release no repositório Striva. Nada foi alterado."
printf '%s' "$RELEASE_JSON" | python3 -c '
import json, sys
try:
    release = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if release.get("tag_name") == sys.argv[1]
         and release.get("draft") is False
         and release.get("prerelease") is False else 1)
' "$TARGET_TAG" || die "A tag não é uma release estável publicada do repositório Striva."

TAG_REFS="$(git ls-remote "$REPOSITORY_URL" "refs/tags/$TARGET_TAG" "refs/tags/$TARGET_TAG^{}")" \
  || die "Não consegui resolver a tag no repositório Striva. Nada foi alterado."
TARGET_COMMIT="$(printf '%s\n' "$TAG_REFS" | python3 -c '
import sys
tag = sys.argv[1]
plain = peeled = ""
for line in sys.stdin:
    parts = line.split()
    if len(parts) != 2:
        continue
    if parts[1] == "refs/tags/" + tag:
        plain = parts[0]
    elif parts[1] == "refs/tags/" + tag + "^{}":
        peeled = parts[0]
print(peeled or plain)
' "$TARGET_TAG")"
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40,64}$ ]] \
  || die "A release publicada não aponta para um commit Git verificável."

IMAGES=(
  "$IMAGE_OWNER/striva-sales:$VERSION"
  "$IMAGE_OWNER/striva-worker:$VERSION"
  "$IMAGE_OWNER/striva-scheduler:$VERSION"
)
info "Validando release $TARGET_TAG e as três imagens publicadas."
for image_ref in "${IMAGES[@]}"; do
  docker pull "$image_ref" >/dev/null \
    || die "Não consegui baixar $image_ref. A instalação atual continua sem alterações."
  source_label="$(docker image inspect "$image_ref" --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' 2>/dev/null)" \
    || die "Não consegui verificar a origem de $image_ref."
  version_label="$(docker image inspect "$image_ref" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' 2>/dev/null)" \
    || die "Não consegui verificar a versão de $image_ref."
  revision_label="$(docker image inspect "$image_ref" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null)" \
    || die "Não consegui verificar a revisão de $image_ref."
  [ "$source_label" = "$IMAGE_SOURCE" ] \
    && [ "$version_label" = "$VERSION" ] \
    && [ "$revision_label" = "$TARGET_COMMIT" ] \
    || die "Os metadados de $image_ref não correspondem à release e ao commit verificados."
done

# Lê e grava apenas valores de dados do .env; nunca executa o arquivo como shell.
env_value() {
  python3 - "$PROJECT_DIR/.env" "$1" <<'PY'
import sys
path, wanted = sys.argv[1:]
try:
    lines = open(path, encoding="utf-8").read().splitlines()
except OSError:
    sys.exit(1)
for line in lines:
    if line.startswith(wanted + "="):
        value = line.split("=", 1)[1].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        print(value)
        break
PY
}

set_env_value() {
  python3 - "$PROJECT_DIR/.env" "$1" "$2" <<'PY'
import os, stat, sys, tempfile
path, key, value = sys.argv[1:]
with open(path, encoding="utf-8") as source:
    lines = source.read().splitlines()
replacement = key + "=" + value
found = False
out = []
for line in lines:
    if line.startswith(key + "="):
        if not found:
            out.append(replacement)
            found = True
    else:
        out.append(line)
if not found:
    out.append(replacement)
mode = stat.S_IMODE(os.stat(path).st_mode)
fd, temp = tempfile.mkstemp(prefix=".env.striva-", dir=os.path.dirname(path))
try:
    os.fchmod(fd, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        target.write("\n".join(out) + "\n")
    os.replace(temp, path)
except Exception:
    try:
        os.unlink(temp)
    except OSError:
        pass
    raise
PY
}

PROJECT_NAME="$(env_value COMPOSE_PROJECT_NAME)"
OBSERVED_PROJECTS="$(docker ps -a \
  --filter "label=com.docker.compose.project.working_dir=$PROJECT_DIR" \
  --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null)" \
  || die "Não consegui consultar a identidade Docker desta instalação."
OBSERVED_PROJECTS="$(printf '%s\n' "$OBSERVED_PROJECTS" | sed '/^$/d' | sort -u)"
if [ "$(printf '%s\n' "$OBSERVED_PROJECTS" | sed '/^$/d' | wc -l | tr -d ' ')" -gt 1 ]; then
  die "A pasta corresponde a mais de um projeto Docker. Resolva a inconsistência antes."
fi
OBSERVED_NAME="$(printf '%s\n' "$OBSERVED_PROJECTS" | sed -n '1p')"
if [ -n "$PROJECT_NAME" ] && [ -n "$OBSERVED_NAME" ] && [ "$PROJECT_NAME" != "$OBSERVED_NAME" ]; then
  die "COMPOSE_PROJECT_NAME diverge dos contêineres em execução. Nenhum serviço foi alterado."
fi
if [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME="${OBSERVED_NAME:-$(basename "$PROJECT_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}"
fi
[[ "$PROJECT_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] \
  || die "Não consegui confirmar um nome Compose seguro para esta instalação."

ROLLBACK_APP=""
ROLLBACK_WORKER=""
ROLLBACK_SCHEDULER=""
for service in app worker scheduler; do
  container="$(docker ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" \
    --filter "label=com.docker.compose.service=$service" | head -1)"
  [ -n "$container" ] || die "Não encontrei o contêiner atual de $service; não consigo preparar rollback."
  state="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)" \
    || die "Não consegui verificar o estado atual de $service."
  [ "$state" = "running|healthy" ] \
    || die "O serviço $service não está saudável ($state). Corrija a instalação antes da migração."
  image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null)" \
    || die "Não consegui identificar a imagem atual de $service."
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || die "A imagem em execução de $service não tem um ID local verificável."
  rollback_ref="localhost/striva-rollback/$service:bootstrap-$(date +%s)-$$"
  docker image tag "$image_id" "$rollback_ref" \
    || die "Não consegui guardar a imagem atual de $service para rollback."
  case "$service" in
    app) ROLLBACK_APP="$rollback_ref" ;;
    worker) ROLLBACK_WORKER="$rollback_ref" ;;
    scheduler) ROLLBACK_SCHEDULER="$rollback_ref" ;;
  esac
done

# Só persiste o nome depois de confirmar que o trio legado está saudável e tem
# imagens locais recuperáveis. O backup legado também usa Compose para localizar
# volumes; preservar o nome real evita criar outro conjunto após o move da pasta.
[ -n "$(env_value COMPOSE_PROJECT_NAME)" ] || set_env_value COMPOSE_PROJECT_NAME "$PROJECT_NAME"

BACKUP_DIR="$(env_value BACKUP_DIR)"
[ -n "$BACKUP_DIR" ] || BACKUP_DIR="$PROJECT_DIR/backups"
case "$BACKUP_DIR" in /*) ;; *) BACKUP_DIR="$PROJECT_DIR/$BACKUP_DIR" ;; esac
mkdir -p "$BACKUP_DIR"
db_before="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'db-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
info "Fazendo backup do banco e das sessões antes de mudar o código."
PRESERVAR_BACKUPS_EXISTENTES=1 bash "$PROJECT_DIR/hostgator-setup-kit/backup.sh" \
  || die "O backup do banco falhou. Código, banco e serviços continuam como estavam."
db_after="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'db-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
[ -n "$db_after" ] && [ -s "$db_after" ] && [ "$db_after" != "$db_before" ] \
  || die "O backup não criou um dump novo e verificável. Não vou mudar o código."
waha_container="$(docker ps -aq \
  --filter "label=com.docker.compose.project=$PROJECT_NAME" \
  --filter 'label=com.docker.compose.service=waha' | head -1)"
[ -n "$waha_container" ] || die "Não encontrei o contêiner WAHA para salvar as sessões."
waha_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/.sessions"}}{{.Name}}{{end}}{{end}}' "$waha_container" 2>/dev/null)" \
  || die "Não consegui identificar o volume das sessões do WhatsApp."
[ -n "$waha_volume" ] || die "As sessões do WhatsApp não estão em um volume nomeado verificável."
session_backup="$BACKUP_DIR/waha-striva-bootstrap-$(date +%Y%m%d-%H%M%S).tgz"
docker run --rm -v "$waha_volume:/data:ro" -v "$BACKUP_DIR:/out" alpine:3.20 \
  tar czf "/out/$(basename "$session_backup")" -C /data . \
  || die "Não consegui salvar as sessões do WhatsApp. O código ainda não foi alterado."
[ -s "$session_backup" ] || die "O arquivo de sessões ficou vazio. O código ainda não foi alterado."

ORIGINAL_COMMIT="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
PRIVATE_REF="refs/distribution/releases/$TARGET_TAG"
git -C "$PROJECT_DIR" fetch --no-tags --quiet "$REPOSITORY_URL" \
  "+refs/tags/$TARGET_TAG:$PRIVATE_REF" \
  || die "Os backups estão prontos, mas não consegui baixar a release verificada."
FETCHED_COMMIT="$(git -C "$PROJECT_DIR" rev-parse "$PRIVATE_REF^{commit}")"
[ "$FETCHED_COMMIT" = "$TARGET_COMMIT" ] \
  || die "A tag mudou entre a validação e o download. Nenhum serviço foi reiniciado."
git -C "$PROJECT_DIR" checkout --detach --quiet "$PRIVATE_REF" \
  || die "Os backups estão prontos, mas não consegui abrir a release Striva."

restore_previous_images() {
  local service container state attempt
  info "A atualização falhou. Restaurando as três imagens que estavam saudáveis."
  (
    cd "$PROJECT_DIR"
    source hostgator-setup-kit/_common.sh
    enter_project
    set_env_var .env APP_IMAGE "$ROLLBACK_APP"
    set_env_var .env APP_PULL_POLICY never
    set_env_var .env WORKER_IMAGE "$ROLLBACK_WORKER"
    set_env_var .env WORKER_PULL_POLICY never
    set_env_var .env SCHEDULER_IMAGE "$ROLLBACK_SCHEDULER"
    set_env_var .env SCHEDULER_PULL_POLICY never
    load_env .env
    export APP_IMAGE="$ROLLBACK_APP" APP_PULL_POLICY=never
    export WORKER_IMAGE="$ROLLBACK_WORKER" WORKER_PULL_POLICY=never
    export SCHEDULER_IMAGE="$ROLLBACK_SCHEDULER" SCHEDULER_PULL_POLICY=never
    dc up -d --no-build app worker scheduler || exit 1
    for service in app worker scheduler; do
      state=""
      for attempt in $(seq 1 20); do
        container="$(dc ps -q "$service" 2>/dev/null | head -1)" || container=""
        [ -n "$container" ] || { sleep 3; continue; }
        state="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)" || state=""
        if [ "$state" = "running|healthy" ]; then break; fi
        sleep 3
      done
      [ "$state" = "running|healthy" ] || exit 1
    done
  )
}

if ! bash "$PROJECT_DIR/hostgator-setup-kit/update.sh" --to "$TARGET_TAG" --force --skip-backup; then
  if restore_previous_images; then
    die "A migração falhou e as imagens anteriores voltaram a ficar saudáveis. O backup do banco está em $db_after; verifique os logs antes de tentar novamente."
  fi
  die "A migração falhou e não consegui confirmar o rollback saudável. Preserve os backups em $BACKUP_DIR e siga o runbook de recuperação."
fi

# O retorno do script não basta: comprova que cada serviço roda a imagem do
# mesmo commit que foi conferido antes do backup.
(
  cd "$PROJECT_DIR"
  source hostgator-setup-kit/_common.sh
  enter_project
  for service in app worker scheduler; do
    container="$(dc ps -q "$service" 2>/dev/null | head -1)"
    [ -n "$container" ] || exit 1
    image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null)" || exit 1
    source_label="$(docker image inspect "$image_id" --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' 2>/dev/null)" || exit 1
    version_label="$(docker image inspect "$image_id" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' 2>/dev/null)" || exit 1
    revision_label="$(docker image inspect "$image_id" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null)" || exit 1
    [ "$source_label" = "$IMAGE_SOURCE" ] && [ "$version_label" = "$VERSION" ] && [ "$revision_label" = "$TARGET_COMMIT" ] || exit 1
    state="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)" || exit 1
    [ "$state" = "running|healthy" ] || exit 1
  done
) || {
  if restore_previous_images; then
    die "A verificação pós-atualização falhou; as imagens anteriores foram restauradas e estão saudáveis. Consulte os logs antes de tentar novamente."
  fi
  die "A verificação pós-atualização e o rollback falharam. Preserve os backups em $BACKUP_DIR e siga o runbook de recuperação."
}

info "Migração para $TARGET_TAG concluída e os três serviços estão saudáveis."
info "Mantenha o nome de projeto Docker atual; a alteração do diretório é um passo separado."
