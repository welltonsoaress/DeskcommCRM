#!/usr/bin/env bash
# Uma imagem ausente deve interromper a ponte antes de backup, checkout ou
# alteração de .env. HTTP, GitHub e Docker são substituídos por dublês locais.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/hostgator-setup-kit/migrar-distribuicao.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REAL_GIT="$(command -v git)"
FAILS=0
check() {
  local description="$1"
  shift
  if "$@"; then printf '  ✓ %s\n' "$description"
  else printf '  ✗ %s\n' "$description"; FAILS=$((FAILS+1)); fi
}
not_contains() { ! grep -q "$1" "$2"; }

mkdir -p "$WORK/bin" "$WORK/project/hostgator-setup-kit" "$WORK/seed"
git -C "$WORK/seed" init --bare --quiet
git -C "$WORK/project" init --quiet
git -C "$WORK/project" config user.email test@example.invalid
git -C "$WORK/project" config user.name test
printf 'APP_NAME="CRM da loja"\n' > "$WORK/project/.env"
printf 'services: {}\n' > "$WORK/project/docker-compose.prod.yml"
printf '# legado\n' > "$WORK/project/hostgator-setup-kit/update.sh"
printf '# backup fake\n' > "$WORK/project/hostgator-setup-kit/backup.sh"
git -C "$WORK/project" add -A
git -C "$WORK/project" commit --quiet -m legacy
OLD_COMMIT="$(git -C "$WORK/project" rev-parse HEAD)"
git -C "$WORK/project" push --quiet "$WORK/seed" HEAD:refs/heads/main
git -C "$WORK/seed" tag striva-v1.0.0 "$OLD_COMMIT"

cat > "$WORK/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '{"tag_name":"striva-v1.0.0","draft":false,"prerelease":false}'
CURL
cat > "$WORK/bin/git" <<'GIT'
#!/usr/bin/env bash
args=()
for arg in "$@"; do
  [ "$arg" = "https://github.com/welltonsoaress/striva-sales.git" ] && arg="$STRIVA_SEED"
  args+=("$arg")
done
printf '%s\n' "$*" >> "$GIT_LOG"
exec "$REAL_GIT" "${args[@]}"
GIT
cat > "$WORK/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = pull ] && [[ "$2" == *striva-scheduler:1.0.0 ]]; then
  exit 1
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  case "$5" in
    *org.opencontainers.image.source*) printf '%s\n' 'https://github.com/welltonsoaress/striva-sales' ;;
    *org.opencontainers.image.version*) printf '%s\n' '1.0.0' ;;
    *org.opencontainers.image.revision*) printf '%s\n' "$STRIVA_COMMIT" ;;
  esac
  exit 0
fi
exit 0
DOCKER
cat > "$WORK/bin/flock" <<'FLOCK'
#!/usr/bin/env bash
exit 0
FLOCK
chmod +x "$WORK/bin/curl" "$WORK/bin/git" "$WORK/bin/docker" "$WORK/bin/flock"
cat > "$WORK/bin/python3" <<'PYTHON'
#!/usr/bin/env bash
case "$2" in
  *"release = json.load"*) exit 0 ;;
  *"peeled = "*) printf '%s\n' "$STRIVA_COMMIT" ;;
  *) exit 97 ;;
esac
PYTHON
chmod +x "$WORK/bin/python3"
export REAL_GIT STRIVA_SEED="$WORK/seed" STRIVA_COMMIT="$OLD_COMMIT" GIT_LOG="$WORK/git.log" DOCKER_LOG="$WORK/docker.log"
export PATH="$WORK/bin:$PATH"
hash -r

cp "$WORK/project/.env" "$WORK/env.before"
set +e
bash "$SCRIPT" "$WORK/project" striva-v1.0.0 > "$WORK/output.log" 2>&1
RESULT=$?
set -e

check "missing scheduler image refuses the migration" test "$RESULT" -ne 0
check "refusal identifies the missing Striva image" grep -q 'Não consegui baixar ghcr.io/welltonsoaress/striva-scheduler:1.0.0' "$WORK/output.log"
if [ -f "$DOCKER_LOG" ]; then
  check "all three own images were preflighted" test "$(grep -c '^pull ' "$DOCKER_LOG")" -eq 3
  check "failure happens before any Docker project inspection" not_contains 'ps -a' "$DOCKER_LOG"
else
  check "Docker is not consulted before the release is resolved" test ! -e "$DOCKER_LOG"
fi
if [ -f "$GIT_LOG" ]; then
  check "failure happens before any Git fetch or checkout" not_contains ' fetch | checkout ' "$GIT_LOG"
else
  check "no Git mutation happened before preflight" test "$(git -C "$WORK/project" rev-parse HEAD)" = "$OLD_COMMIT"
fi
check "tracked legacy checkout remains at its original commit" test "$(git -C "$WORK/project" rev-parse HEAD)" = "$OLD_COMMIT"
check "legacy environment remains unchanged" cmp -s "$WORK/env.before" "$WORK/project/.env"
check "database backup did not run" test ! -e "$WORK/project/backups"
echo
if [ "$FAILS" -eq 0 ]; then echo "OK — the legacy distribution bridge fails closed before changing the installation."; else echo "FAILED — $FAILS assertion(s)."; fi
exit "$FAILS"
