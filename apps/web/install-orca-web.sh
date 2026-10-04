#!/usr/bin/env bash
# Готовый Web artifact: на сервере не нужны исходники, pnpm и компилятор.
set -euo pipefail
umask 077
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then echo 'Поддерживается Linux x64 (Ubuntu 24.04).' >&2; exit 1; fi
confirm() {
  printf '%s\n' "$1"
  local answer
  read -r answer || { echo 'Установка отменена.' >&2; exit 1; }
  [[ $answer == "$2" ]] || { echo 'Установка отменена.' >&2; exit 1; }
}
echo 'Orca Web · подготовка сервера'
service_user=$(id -un)
service_home=$HOME
root_ack=${ORCA_WEB_ACK_ROOT:-0}
if [[ $(id -u) == 0 ]]; then
  prior_current=${ORCA_WEB_HOME:-"$HOME/.local/share/orca-web"}/current
  prior_uid=0
  if [[ -e $prior_current || -L $prior_current ]]; then prior_uid=$(stat -c '%u' "$prior_current"); fi
  if [[ $prior_uid != 0 ]]; then
    service_user=$(getent passwd "$prior_uid" | cut -d: -f1)
    service_home=$(getent passwd "$prior_uid" | cut -d: -f6)
    [[ -n $service_user && -n $service_home ]] || { echo 'Владелец существующей установки не найден. Каталог сохранён.' >&2; exit 1; }
    echo "Обнаружена существующая установка под пользователем $service_user."
    if [[ ${ORCA_WEB_NO_SETUP:-0} != 1 ]]; then
      confirm "Предупреждение: Orca сохраняет права пользователя $service_user на его файлы и CLI-авторизацию. Для использования введите USE:" USE
    fi
  elif [[ $root_ack != 1 && ${ORCA_WEB_NO_SETUP:-0} != 1 && ! -e $prior_current ]]; then
    echo '1. Создать обычного пользователя orca автоматически (рекомендуется).'
    echo '2. Установить Orca под root.'
    printf 'Пользователь сервиса [1]: '
    read -r choice || exit 1
    case ${choice:-1} in
      1)
        printf 'Имя обычного пользователя [orca]: '
        read -r service_user || exit 1
        service_user=${service_user:-orca}
        if [[ ! $service_user =~ ^[a-z_][a-z0-9_-]*$ || $service_user == root ]]; then echo 'Некорректное имя пользователя.' >&2; exit 1; fi
        if getent passwd "$service_user" >/dev/null; then
          confirm "Предупреждение: пользователь $service_user уже существует. Orca получит доступ к его файлам и CLI-авторизации. Для использования введите USE:" USE
        else
          useradd --create-home --shell /bin/bash "$service_user"
          echo "Создан пользователь $service_user без пароля; SSH-ключи и credentials root не копируются."
        fi
        service_home=$(getent passwd "$service_user" | cut -d: -f6)
        ;;
      2) service_user=root ;;
      *) echo 'Выберите 1 или 2.' >&2; exit 1 ;;
    esac
  fi
  if [[ $service_user == root && $root_ack != 1 ]]; then
    confirm 'Предупреждение: Orca и CLI-агенты будут работать с правами root, включая файлы сайта и всего сервера. Для продолжения введите ROOT (Enter — отмена):' ROOT
    root_ack=1
  fi
fi
missing=()
for tool in curl tar sha256sum python3 git; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if [[ ${#missing[@]} != 0 ]]; then
  echo "Для установки нужны: ${missing[*]}."
  if ! command -v apt-get >/dev/null; then echo 'Установите эти зависимости пакетным менеджером и повторите установщик.' >&2; exit 1; fi
  confirm 'Установщик добавит Git, curl, tar, Python, сертификаты и системные утилиты через apt. Для подтверждения введите INSTALL:' INSTALL
  admin=()
  if [[ $(id -u) != 0 ]]; then admin=(sudo); fi
  "${admin[@]}" apt-get update
  "${admin[@]}" apt-get install -y --no-install-recommends git curl tar coreutils python3 ca-certificates iproute2 util-linux
fi
base=${ORCA_WEB_HOME:-"$service_home/.local/share/orca-web"}
config_file=${ORCA_WEB_CONFIG:-"$service_home/.config/orca-web/config.json"}
if [[ $base != /* || $base == *$'\n'* || $base == *$'\r'* ]]; then echo 'Некорректный путь установки' >&2; exit 1; fi
service_uid=$(id -u "$service_user")
if [[ $service_uid == 0 && $root_ack != 1 ]]; then
  confirm 'Предупреждение: выбранный пользователь имеет UID 0 и полные права root. Для продолжения введите ROOT:' ROOT
  root_ack=1
fi
# Root не пишет через симлинки/общедоступные каталоги пользователя сервиса.
python3 - "$base" "$service_home" "$config_file" "$service_uid" <<'PY'
import os,stat,sys
uid=int(sys.argv[4])
base=os.path.normpath(sys.argv[1])
paths=sys.argv[1:4]+[base+'/bin',base+'/bin/orca-web',base+'/releases']
if uid==0 and os.path.lexists(base+'/current'):
    if os.lstat(base+'/current').st_uid!=0: raise SystemExit('Root не запускает код обычного пользователя')
    release=os.path.realpath(base+'/current')
    if os.path.commonpath([base+'/releases',release])!=base+'/releases': raise SystemExit('Пакет root должен находиться в каталоге releases этой установки')
    paths += [release+'/node/bin/node',release+'/app/control.mjs']
for value in paths:
    if not os.path.isabs(value) or any(ord(c)<32 or ord(c)==127 for c in value): raise SystemExit('Некорректный абсолютный путь установки')
    current='/'
    for part in os.path.normpath(value).split('/')[1:]:
        current=os.path.join(current,part)
        try: info=os.lstat(current)
        except FileNotFoundError: break
        if stat.S_ISLNK(info.st_mode): raise SystemExit('Установка не пишет через симлинки: '+current)
        if info.st_uid not in (0,uid): raise SystemExit('Небезопасный владелец пути: '+current)
        if info.st_mode & 0o022 and not (stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX and info.st_uid==0): raise SystemExit('Небезопасные права пути: '+current)
PY
ssh_target=${ORCA_WEB_SSH_TARGET:-}
ssh_port=${ORCA_WEB_SSH_PORT:-}
if [[ -z $ssh_target && -n ${SSH_CONNECTION:-} ]]; then
  read -r _ _ server_ip ssh_port <<< "$SSH_CONNECTION"
  ssh_target="${SUDO_USER:-$(id -un)}@$server_ip"
fi
run_target() {
  local target_env=("HOME=$service_home" "ORCA_WEB_HOME=$base" "ORCA_WEB_CONFIG=$config_file" ORCA_WEB_INSTALLER=1 "ORCA_WEB_ACK_ROOT=$root_ack" "ORCA_WEB_SSH_TARGET=$ssh_target" "ORCA_WEB_SSH_PORT=$ssh_port" "PATH=$base/current/node/bin:$service_home/.local/bin:/usr/local/bin:/usr/bin:/bin")
  if [[ $(id -u) == 0 && $service_uid != 0 ]]; then runuser -u "$service_user" -- env -i "${target_env[@]}" "TERM=${TERM:-xterm}" "LANG=${LANG:-C.UTF-8}" "USER=$service_user" "LOGNAME=$service_user" "$@"
  else env "${target_env[@]}" "$@"; fi
}
repo=NANDIorg/BigOrcaCocks
version=${ORCA_WEB_VERSION:-}
if [[ -z $version ]]; then
  version=$(curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://api.github.com/repos/$repo/releases?per_page=100" | python3 -c 'import json,re,sys; tags=[r["tag_name"][5:] for r in json.load(sys.stdin) if not r.get("draft",True) and not r.get("prerelease",True) and re.fullmatch(r"web/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)",r.get("tag_name",""))]; print(max(tags,key=lambda v:tuple(map(int,v.split(".")))) if tags else "")')
fi
if [[ ! $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then echo 'Не найден стабильный релиз Orca Web' >&2; exit 1; fi
echo "Скачиваю Orca Web $version и проверяю SHA256…"
work=$(mktemp -d /tmp/orca-web-install.XXXXXXXX)
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
if (process.env.ORCA_WEB_NO_SETUP !== '1' && release.setupWizardVersion !== 2) throw new Error('Этот установщик требует пакет с пошаговым мастером (Web 2.1.0 или новее). Выберите актуальный выпуск; старые пакеты используют свой установщик.')
for (const file of ['node/bin/node', 'app/control.mjs', 'app/browser/index.html']) {
  const path = realpathSync(join(root, file)); const rel = relative(realpathSync(root), path)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || !statSync(path).isFile()) throw new Error('Небезопасный artifact')
}
JS
# Публичные файлы доступны для копирования, но изменять проверенный root-пакет может только root.
if [[ $(id -u) == 0 && $service_uid != 0 ]]; then chmod a+rx "$work"; chmod -R a+rX "$work/orca-web"; fi
admin_provision() {
  local action=$1
  if [[ $(id -u) == 0 ]]; then
    env PATH=/usr/sbin:/usr/bin:/sbin:/bin NODE_OPTIONS= NODE_PATH= ORCA_WEB_SSH_TARGET="$ssh_target" ORCA_WEB_SSH_PORT="$ssh_port" "$work/orca-web/node/bin/node" "$work/orca-web/app/control.mjs" "$action" "$config_file" "$base" "$service_user" "$service_home"
  else
    echo 'Для системной настройки пакет будет повторно скачан и проверен в приватном каталоге root.'
    # sudo запускает системный Python с фиксированной программой, а не пользовательские Node/control.
    sudo /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/python3 -I - "$version" "$action" "$config_file" "$base" "$service_user" "$service_home" "$ssh_target" "$ssh_port" <<'PY'
import hashlib,json,os,re,subprocess,sys,tarfile,tempfile,urllib.request
version,action,config,base,user,home,target,port=sys.argv[1:]
if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)',version) or action not in ('provision','provision-app'): raise SystemExit('Некорректный план provision')
class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  if not newurl.startswith('https://'): raise ValueError('Только HTTPS download')
  return super().redirect_request(req,fp,code,msg,headers,newurl)
opener=urllib.request.build_opener(HTTPSRedirect)
prefix='https://github.com/NANDIorg/BigOrcaCocks/releases/download/web%2Fv'+version
asset='orca-web-linux-x64-'+version+'.tar.gz'
with tempfile.TemporaryDirectory(prefix='orca-web-admin-',dir='/var/tmp') as work:
 with opener.open(prefix+'/SHA256SUMS',timeout=30) as response: sums=response.read(16384).decode()
 expected=[line.split()[0] for line in sums.splitlines() if len(line.split())==2 and line.split()[1]==asset]
 if len(expected)!=1 or not re.fullmatch('[a-f0-9]{64}',expected[0]): raise ValueError('Нет SHA256 artifact')
 archive=os.path.join(work,asset); digest=hashlib.sha256(); size=0
 with opener.open(prefix+'/'+asset,timeout=60) as response,open(archive,'xb') as output:
  while True:
   chunk=response.read(1024*1024)
   if not chunk: break
   size+=len(chunk)
   if size>512*1024*1024: raise ValueError('Слишком большой artifact')
   digest.update(chunk); output.write(chunk)
 if digest.hexdigest()!=expected[0]: raise ValueError('SHA256 не совпадает')
 with tarfile.open(archive,'r:gz') as bundle:
  for item in bundle.getmembers():
   parts=item.name.split('/')
   if parts[0]!='orca-web' or any(part in ('.','..') for part in parts) or '\\' in item.name or not(item.isfile() or item.isdir()): raise ValueError('Небезопасный archive')
  bundle.extractall(work,filter='data')
 root=os.path.join(work,'orca-web')
 with open(root+'/release.json') as file: release=json.load(file)
 with open(root+'/app/package.json') as file: manifest=json.load(file)
 if manifest.get('name')!='@orca-board/web' or manifest.get('version')!=version or release.get('version')!=version or release.get('platform')!='linux' or release.get('arch')!='x64' or release.get('schemaVersion')!=1 or release.get('setupWizardVersion')!=2: raise ValueError('Несовместимый artifact')
 subprocess.run([root+'/node/bin/node',root+'/app/control.mjs',action,config,base,user,home],check=True,cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','ORCA_WEB_SSH_TARGET':target,'ORCA_WEB_SSH_PORT':port})
PY
  fi
}
existing=0
if [[ -e $base/current || -L $base/current ]]; then existing=1; fi
if [[ $existing == 1 && -e $config_file ]]; then
  installed_version=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$base/current/app/package.json")
  if [[ $installed_version != "$version" ]]; then
    confirm "Предупреждение: обновление $installed_version → $version остановит задания и перезапустит Orca. Конфигурация будет сохранена. Для продолжения введите UPDATE:" UPDATE
    if [[ ! -e /etc/systemd/system/orca-web.service ]]; then
      if run_target "$base/bin/orca-web" status >/dev/null 2>&1; then echo 'Orca запущена вручную. Остановите её в исходном терминале и повторите установщик; чужие процессы не завершаются автоматически.' >&2; exit 1; fi
      admin_provision provision-app
    fi
    run_target "$base/bin/orca-web" update
    installed_version=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$base/current/app/package.json")
    if [[ $installed_version != "$version" ]]; then echo 'Выбранная версия не активирована. Используйте стабильный опубликованный выпуск.' >&2; exit 1; fi
  fi
else
  if ! run_target /usr/bin/mkdir -p "$base" 2>/dev/null; then
    if [[ $(id -u) != 0 || $service_uid == 0 ]]; then echo 'Нет доступа к каталогу установки.' >&2; exit 1; fi
    # Custom base под /srv: root создаёт только новые каталоги в собственном дереве.
    # В существующие пользовательские каталоги root не пишет и через ссылки не проходит.
    python3 -I - "$base" "$service_uid" <<'PY'
import os,stat,sys
path=os.path.normpath(sys.argv[1]); uid=int(sys.argv[2]); current='/'; created=[]
for part in path.split('/')[1:]:
 current=os.path.join(current,part)
 try:
  info=os.lstat(current)
  if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022: raise SystemExit('Root не изменяет существующий пользовательский каталог: '+current)
 except FileNotFoundError:
  os.mkdir(current,0o755); created.append(current)
if path not in created: raise SystemExit('Каталог установки уже существует и недоступен пользователю; исправьте права вручную.')
os.chown(path,uid,-1)
PY
  fi
  run_target /usr/bin/mkdir -p "$base/releases" "$base/bin" "$service_home/.local/bin"
  if [[ -e $base/releases/$version ]]; then
    echo 'Каталог версии уже существует после незавершённой установки. Проверяю его…'
    cmp "$work/orca-web/release.json" "$base/releases/$version/release.json" || { echo 'Каталог версии отличается от пакета; сохранён без изменения.' >&2; exit 1; }
  else
    # Оригинал остаётся root-owned: он используется для административного provision.
    run_target /usr/bin/cp -a --no-preserve=ownership "$work/orca-web" "$base/releases/$version"
  fi
  if [[ $existing == 1 ]]; then
    run_target /usr/bin/ln -s "$base/releases/$version" "$base/.current-install-$$"
    run_target /usr/bin/mv -Tf "$base/.current-install-$$" "$base/current"
  else run_target /usr/bin/ln -s "$base/releases/$version" "$base/current"; fi
  run_target /usr/bin/cp "$work/orca-web/bin/orca-web" "$base/bin/orca-web"
fi
run_target /usr/bin/chmod 755 "$base/bin/orca-web"
link="$service_home/.local/bin/orca-web"
if [[ -e $link || -L $link ]]; then
  if [[ $(readlink "$link" || true) != "$base/bin/orca-web" ]]; then
    confirm "Предупреждение: $link занят другим файлом. Он будет сохранён; используйте $base/bin/orca-web. Для продолжения введите CONTINUE:" CONTINUE
  fi
else run_target /usr/bin/ln -s "$base/bin/orca-web" "$link"; fi
echo "Orca Web $version установлена для пользователя $service_user."
if [[ ${ORCA_WEB_NO_SETUP:-0} != 1 ]]; then
  command=setup
  if [[ -e $config_file ]]; then command=configure; fi
  run_target "$base/bin/orca-web" "$command"
  automatic=$(python3 -c 'import json,sys;print(int(json.load(open(sys.argv[1]))["provision"]))' "$(dirname "$config_file")/setup-plan.json")
  if [[ $automatic == 1 ]]; then
    admin_provision provision
  fi
  run_target "$base/bin/orca-web" agents install
fi
echo "Команда управления: $base/bin/orca-web"
