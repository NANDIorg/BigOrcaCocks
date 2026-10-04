#!/usr/bin/env bash
# Готовый Web artifact: на сервере не нужны исходники, pnpm и компилятор.
set -euo pipefail
umask 077
if [[ $(id -u) == 0 ]]; then
  echo 'Предупреждение: установка под root. Orca Web и CLI-агенты будут работать с правами root и смогут изменять любые файлы на сервере. Рекомендуется отдельный пользователь проектов; установка продолжится.' >&2
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then echo 'Поддерживается Linux x64 (Ubuntu 24.04).' >&2; exit 1; fi
for tool in curl tar sha256sum python3; do command -v "$tool" >/dev/null || { echo "Установите $tool" >&2; exit 1; }; done
base=${ORCA_WEB_HOME:-"$HOME/.local/share/orca-web"}
if [[ $base != /* || $base == *$'\n'* || $base == *$'\r'* ]]; then echo 'Некорректный путь установки' >&2; exit 1; fi
repo=NANDIorg/BigOrcaCocks
version=${ORCA_WEB_VERSION:-}
if [[ -z $version ]]; then
  version=$(curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://api.github.com/repos/$repo/releases?per_page=100" | python3 -c 'import json,re,sys; tags=[r["tag_name"][5:] for r in json.load(sys.stdin) if not r.get("draft",True) and not r.get("prerelease",True) and re.fullmatch(r"web/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)",r.get("tag_name",""))]; print(max(tags,key=lambda v:tuple(map(int,v.split(".")))) if tags else "")')
fi
if [[ ! $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then echo 'Не найден стабильный релиз Orca Web' >&2; exit 1; fi
mkdir -p "$base/releases" "$base/bin" "$HOME/.local/bin"
if [[ -e $base/current || -L $base/current ]]; then echo 'Orca Web уже установлена. Обновление: orca-web update' >&2; exit 1; fi
work=$(mktemp -d "$base/.install.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
asset="orca-web-linux-x64-$version.tar.gz"
prefix="https://github.com/$repo/releases/download/web%2Fv$version"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$prefix/$asset" -o "$work/$asset"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$prefix/SHA256SUMS" -o "$work/SHA256SUMS"
checksum=$(awk -v name="$asset" '$2 == name && length($1) == 64 { print $1 }' "$work/SHA256SUMS")
if [[ ! $checksum =~ ^[a-f0-9]{64}$ ]]; then echo 'Нет контрольной суммы Web artifact' >&2; exit 1; fi
(cd "$work"; printf '%s  %s\n' "$checksum" "$asset" | sha256sum --check --status)
tar -tzf "$work/$asset" > "$work/contents"
if ! awk 'BEGIN { valid=1 } { if ($0 !~ /^orca-web(\/|$)/ || $0 ~ /(^|\/)\.\.(\/|$)/ || $0 ~ /(^|\/)\.(\/|$)/ || $0 ~ /\\/) valid=0 } END { exit !valid }' "$work/contents"; then echo 'Небезопасные пути archive' >&2; exit 1; fi
tar -tvzf "$work/$asset" > "$work/details"
if ! awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" { exit 1 }' "$work/details"; then echo 'Archive должен содержать только обычные файлы и каталоги' >&2; exit 1; fi
tar -xzf "$work/$asset" --no-same-owner -C "$work"
"$work/orca-web/node/bin/node" --input-type=module - "$work/orca-web" "$version" <<'JS'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
const [root, version] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(join(root, 'app/package.json'), 'utf8'))
const release = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'))
if (manifest.name !== '@orca-board/web' || manifest.version !== version || release.version !== version || release.platform !== 'linux' || release.arch !== 'x64' || release.schemaVersion !== 1) throw new Error('Несовместимый Web artifact')
for (const file of ['node/bin/node', 'app/control.mjs', 'app/browser/index.html']) {
  const path = realpathSync(join(root, file)); const rel = relative(realpathSync(root), path)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || !statSync(path).isFile()) throw new Error('Небезопасный artifact')
}
JS
if [[ -e $base/releases/$version ]]; then echo 'Каталог версии уже существует; проверьте предыдущую установку.' >&2; exit 1; fi
mv "$work/orca-web" "$base/releases/$version"
ln -s "$base/releases/$version" "$base/current"
cp "$base/current/bin/orca-web" "$base/bin/orca-web"
chmod 755 "$base/bin/orca-web"
if [[ -e $HOME/.local/bin/orca-web || -L $HOME/.local/bin/orca-web ]]; then echo 'Файл ~/.local/bin/orca-web уже существует; launcher установлен в каталоге Orca.' >&2
else ln -s "$base/bin/orca-web" "$HOME/.local/bin/orca-web"; fi
export ORCA_WEB_HOME="$base"
echo "Orca Web $version установлена."
if [[ ${ORCA_WEB_NO_SETUP:-0} != 1 ]]; then "$base/bin/orca-web" setup; fi
echo 'Если orca-web не находится: добавьте ~/.local/bin в PATH.'
