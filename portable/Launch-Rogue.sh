#!/bin/sh
# Rogue — portable launcher (Linux x86-64)
# No install of the app itself, no FUSE, no root needed for the app.
# It only ever touches the SYSTEM if a library Electron needs is missing:
#   1. checks the libraries Electron needs (ldconfig)
#   2. installs ONLY the missing ones with your package manager
#      (asks for your password once, via pkexec or sudo)
#   3. starts the app
# Skip the check with:  ROGUE_SKIP_DEPS=1 ./Launch-Rogue-Arsenal.sh
# Show what would be installed, without installing:  ROGUE_DEPS_DRYRUN=1 ./Launch-Rogue-Arsenal.sh
set -u
# hidden mode: run the package install as root (pkexec/sudo call this back)
if [ "${1:-}" = "--install-deps" ]; then
  shift; PM="$1"; shift
  case "$PM" in
    apt) apt-get update; for p in "$@"; do apt-get install -y "$p" || apt-get install -y "${p}t64" || echo "[rogue] could not install $p"; done ;;
    dnf) dnf install -y "$@" ;;
    pacman) pacman -S --noconfirm "$@" ;;
    zypper) zypper install -y "$@" ;;
  esac
  exit 0
fi
cd "$(dirname "$0")" || exit 1

# soname : apt-package : dnf-package : pacman-package : zypper-package
DEPS_LIST='
libgtk-3.so.0:libgtk-3-0:gtk3:gtk3:libgtk-3-0
libgdk-3.so.0:libgtk-3-0:gtk3:gtk3:libgtk-3-0
libgdk_pixbuf-2.0.so.0:libgdk-pixbuf-2.0-0:gdk-pixbuf2:gdk-pixbuf2:libgdk_pixbuf-2_0-0
libgio-2.0.so.0:libglib2.0-0:glib2:glib2:libglib-2_0-0
libgobject-2.0.so.0:libglib2.0-0:glib2:glib2:libglib-2_0-0
libgmodule-2.0.so.0:libglib2.0-0:glib2:glib2:libglib-2_0-0
libnotify.so.4:libnotify4:libnotify:libnotify:libnotify4
libnss3.so:libnss3:nss:nss:mozilla-nss
libXss.so.1:libxss1:libXScrnSaver:libxss:libXss1
libXtst.so.6:libxtst6:libXtst:libxtst:libXtst6
libatspi.so.0:libatspi2.0-0:at-spi2-core:at-spi2-core:at-spi2-core
libuuid.so.1:libuuid1:libuuid:util-linux-libs:libuuid1
libsecret-1.so.0:libsecret-1-0:libsecret:libsecret:libsecret-1-0
libasound.so.2:libasound2:alsa-lib:alsa-lib:alsa-lib
libgbm.so.1:libgbm1:mesa-libgbm:mesa:Mesa-libgbm1
libdrm.so.2:libdrm2:libdrm:libdrm:libdrm2
libxkbcommon.so.0:libxkbcommon0:libxkbcommon:libxkbcommon:libxkbcommon0
libXcomposite.so.1:libxcomposite1:libXcomposite:libxcomposite:libXcomposite1
libXdamage.so.1:libxdamage1:libXdamage:libxdamage:libXdamage1
libXrandr.so.2:libxrandr2:libXrandr:libxrandr:libXrandr2
libXcursor.so.1:libxcursor1:libXcursor:libxcursor:libXcursor1
libXi.so.6:libxi6:libXi:libxi:libXi6
libXinerama.so.1:libxinerama1:libXinerama:libxinerama:libXinerama1
libXrender.so.1:libxrender1:libXrender:libxrender:libXrender1
libcups.so.2:libcups2:cups-libs:libcups:cups
libpango-1.0.so.0:libpango-1.0-0:pango:pango:pango
libpangoft2-1.0.so.0:libpango-1.0-0:pango:pango:pango
libpangocairo-1.0.so.0:libpango-1.0-0:pango:pango:pango
libcairo.so.2:libcairo2:cairo:cairo:cairo
libpixman-1.so.0:libpixman-1-0:pixman:pixman:libpixman-1-0
libfontconfig.so.1:libfontconfig1:fontconfig:fontconfig:fontconfig
libfreetype.so.6:libfreetype6:freetype:freetype2:libfreetype6
libpng16.so.16:libpng16-16:libpng:libpng:libpng16-16
libatk-1.0.so.0:libatk1.0-0:atk:atk:libatk-1_0-0
libatk-bridge-2.0.so.0:libatk-bridge2.0-0:at-spi2-atk:at-spi2-atk:at-spi2-atk
libX11.so.6:libx11-6:libX11:libx11:libX11-6
libxcb.so.1:libxcb1:libxcb:libxcb:libxcb1
libxcb-render.so.0:libxcb-render0:libxcb:libxcb:libxcb-render0
libxcb-shm.so.0:libxcb-shm0:libxcb:libxcb:libxcb-shm0
libXext.so.6:libxext6:libXext:libxext:libXext6
libXfixes.so.3:libxfixes3:libXfixes:libxfixes:libXfixes3
libglib-2.0.so.0:libglib2.0-0:glib2:glib2:libglib-2_0-0
libnspr4.so:libnspr4:nspr:nspr:mozilla-nspr
libdbus-1.so.3:libdbus-1-3:dbus-libs:dbus:dbus-1
libexpat.so.1:libexpat1:expat:expat:libexpat1
'

detect_pm() {
  # returns: apt | dnf | pacman | zypper | (empty)
  OSID=""; OSLIKE=""
  if [ -r /etc/os-release ]; then
    OSID=$(grep '^ID=' /etc/os-release | head -1 | cut -d= -f2 | tr -d '"')
    OSLIKE=$(grep '^ID_LIKE=' /etc/os-release | head -1 | cut -d= -f2 | tr -d '"')
  fi
  case " $OSID $OSLIKE " in
    *debian*|*ubuntu*|*kali*|*mint*|*pop*|*raspbian*) echo apt; return ;;
    *fedora*|*rhel*|*centos*|*rocky*|*alma*|*oracle*) echo dnf; return ;;
    *arch*|*manjaro*|*endeavouros*) echo pacman; return ;;
    *suse*|*opensuse*) echo zypper; return ;;
  esac
  command -v apt-get >/dev/null 2>&1 && { echo apt; return; }
  command -v dnf >/dev/null 2>&1 && { echo dnf; return; }
  command -v pacman >/dev/null 2>&1 && { echo pacman; return; }
  command -v zypper >/dev/null 2>&1 && { echo zypper; return; }
  echo ""
}

check_deps() {
  if [ "${ROGUE_SKIP_DEPS:-0}" = "1" ]; then
    echo "[rogue] dependency check skipped (ROGUE_SKIP_DEPS=1)"
    return 0
  fi
  PM=$(detect_pm)
  [ -z "$PM" ] && { echo "[rogue] no supported package manager found — skipping dependency check"; return 0; }
  # ldconfig lives in /sbin on many distros — not always in PATH
  LDCONFIG=$(command -v ldconfig 2>/dev/null)
  [ -z "$LDCONFIG" ] && [ -x /sbin/ldconfig ] && LDCONFIG=/sbin/ldconfig
  [ -z "$LDCONFIG" ] && [ -x /usr/sbin/ldconfig ] && LDCONFIG=/usr/sbin/ldconfig
  LDCACHE=$("$LDCONFIG" -p 2>/dev/null)
  MISSING=""
  # shellcheck disable=SC2039
  while IFS=: read -r SONAME APT DNF PACMAN ZYPPER; do
    [ -z "$SONAME" ] && continue
    case "$LDCACHE" in *"$SONAME"*) ;; *)
      case "$PM" in
        apt) PKG="$APT" ;; dnf) PKG="$DNF" ;; pacman) PKG="$PACMAN" ;; zypper) PKG="$ZYPPER" ;;
      esac
      case " $MISSING " in *" $PKG "*) ;; *) MISSING="$MISSING $PKG" ;; esac
    esac
  done <<EOF
$DEPS_LIST
EOF
  MISSING=$(echo "$MISSING" | sed 's/^ *//')
  [ -z "$MISSING" ] && { echo "[rogue] all system dependencies present ✓"; return 0; }
  echo "[rogue] missing system libraries — installing: $MISSING"
  case "$PM" in
    apt)    CMD="apt-get update && apt-get install -y $MISSING" ;;
    dnf)    CMD="dnf install -y $MISSING" ;;
    pacman) CMD="pacman -S --noconfirm $MISSING" ;;
    zypper) CMD="zypper install -y $MISSING" ;;
  esac
  if [ "${ROGUE_DEPS_DRYRUN:-0}" = "1" ]; then
    echo "[rogue] dry run — would install with: sudo $CMD"
    return 0
  fi
  SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  # privilege escalation: graphical prompt first, then terminal sudo
  if command -v pkexec >/dev/null 2>&1; then
    echo "[rogue] asking for your password to install the missing libraries…"
    if pkexec sh "$SELF" --install-deps "$PM" $MISSING; then
      echo "[rogue] dependencies installed ✓"
      return 0
    fi
    echo "[rogue] pkexec install failed — trying sudo…"
  fi
  if sudo -n true 2>/dev/null; then
    if sudo sh "$SELF" --install-deps "$PM" $MISSING; then echo "[rogue] dependencies installed ✓"; return 0; fi
  elif [ -t 0 ]; then
    echo "[rogue] asking for your password to install the missing libraries…"
    if sudo sh "$SELF" --install-deps "$PM" $MISSING; then echo "[rogue] dependencies installed ✓"; return 0; fi
  fi
  echo "[rogue] automatic install did not work. Please run this once in a terminal:"
  echo "        sudo $CMD"
  echo "        (on newer Ubuntu/Debian, a package may need its t64 name, e.g. libasound2t64)"
  echo "[rogue] continuing anyway — the app may fail to start until the libraries are installed."
  return 0
}

check_deps
chmod +x rogue 2>/dev/null
exec ./rogue "$@"
