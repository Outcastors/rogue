// deps.js — system libraries Electron needs, and how to get them.
// Used by main.js (in-app check + install offer) and mirrored in the portable
// launcher (Launch-Rogue-Arsenal.sh). Keep the two in sync.
const fs = require('fs');
const { execFile } = require('child_process');

// soname Electron links against -> package name per distro family
const DEPS = [
  { soname: 'libgtk-3.so.0',          apt: 'libgtk-3-0',        dnf: 'gtk3',          pacman: 'gtk3',          zypper: 'libgtk-3-0' },
  { soname: 'libgdk-3.so.0',          apt: 'libgtk-3-0',        dnf: 'gtk3',          pacman: 'gtk3',          zypper: 'libgtk-3-0' },
  { soname: 'libgdk_pixbuf-2.0.so.0', apt: 'libgdk-pixbuf-2.0-0', dnf: 'gdk-pixbuf2',   pacman: 'gdk-pixbuf2',   zypper: 'libgdk_pixbuf-2_0-0' },
  { soname: 'libgio-2.0.so.0',        apt: 'libglib2.0-0',      dnf: 'glib2',         pacman: 'glib2',         zypper: 'libglib-2_0-0' },
  { soname: 'libgobject-2.0.so.0',    apt: 'libglib2.0-0',      dnf: 'glib2',         pacman: 'glib2',         zypper: 'libglib-2_0-0' },
  { soname: 'libgmodule-2.0.so.0',    apt: 'libglib2.0-0',      dnf: 'glib2',         pacman: 'glib2',         zypper: 'libglib-2_0-0' },
  { soname: 'libnotify.so.4',         apt: 'libnotify4',         dnf: 'libnotify',     pacman: 'libnotify',     zypper: 'libnotify4' },
  { soname: 'libnss3.so',             apt: 'libnss3',            dnf: 'nss',           pacman: 'nss',           zypper: 'mozilla-nss' },
  { soname: 'libXss.so.1',            apt: 'libxss1',            dnf: 'libXScrnSaver', pacman: 'libxss',        zypper: 'libXss1' },
  { soname: 'libXtst.so.6',           apt: 'libxtst6',           dnf: 'libXtst',        pacman: 'libxtst',       zypper: 'libXtst6' },
  { soname: 'libatspi.so.0',          apt: 'libatspi2.0-0',      dnf: 'at-spi2-core',   pacman: 'at-spi2-core',  zypper: 'at-spi2-core' },
  { soname: 'libuuid.so.1',           apt: 'libuuid1',           dnf: 'libuuid',        pacman: 'util-linux-libs', zypper: 'libuuid1' },
  { soname: 'libsecret-1.so.0',       apt: 'libsecret-1-0',      dnf: 'libsecret',      pacman: 'libsecret',     zypper: 'libsecret-1-0' },
  { soname: 'libasound.so.2',         apt: 'libasound2',         dnf: 'alsa-lib',       pacman: 'alsa-lib',     zypper: 'alsa-lib' },
  { soname: 'libgbm.so.1',            apt: 'libgbm1',            dnf: 'mesa-libgbm',    pacman: 'mesa',          zypper: 'Mesa-libgbm1' },
  { soname: 'libdrm.so.2',            apt: 'libdrm2',            dnf: 'libdrm',         pacman: 'libdrm',        zypper: 'libdrm2' },
  { soname: 'libxkbcommon.so.0',      apt: 'libxkbcommon0',      dnf: 'libxkbcommon',   pacman: 'libxkbcommon',  zypper: 'libxkbcommon0' },
  { soname: 'libXcomposite.so.1',     apt: 'libxcomposite1',     dnf: 'libXcomposite',  pacman: 'libxcomposite', zypper: 'libXcomposite1' },
  { soname: 'libXdamage.so.1',        apt: 'libxdamage1',        dnf: 'libXdamage',     pacman: 'libxdamage',   zypper: 'libXdamage1' },
  { soname: 'libXrandr.so.2',         apt: 'libxrandr2',         dnf: 'libXrandr',       pacman: 'libxrandr',     zypper: 'libXrandr2' },
  { soname: 'libXcursor.so.1',        apt: 'libxcursor1',        dnf: 'libXcursor',     pacman: 'libxcursor',    zypper: 'libXcursor1' },
  { soname: 'libXi.so.6',             apt: 'libxi6',             dnf: 'libXi',          pacman: 'libxi',         zypper: 'libXi6' },
  { soname: 'libXinerama.so.1',       apt: 'libxinerama1',       dnf: 'libXinerama',    pacman: 'libxinerama',   zypper: 'libXinerama1' },
  { soname: 'libXrender.so.1',        apt: 'libxrender1',        dnf: 'libXrender',     pacman: 'libxrender',    zypper: 'libXrender1' },
  { soname: 'libcups.so.2',           apt: 'libcups2',           dnf: 'cups-libs',      pacman: 'libcups',       zypper: 'cups' },
  { soname: 'libpango-1.0.so.0',      apt: 'libpango-1.0-0',     dnf: 'pango',          pacman: 'pango',         zypper: 'pango' },
  { soname: 'libpangoft2-1.0.so.0',   apt: 'libpango-1.0-0',     dnf: 'pango',          pacman: 'pango',         zypper: 'pango' },
  { soname: 'libpangocairo-1.0.so.0', apt: 'libpango-1.0-0',     dnf: 'pango',          pacman: 'pango',         zypper: 'pango' },
  { soname: 'libcairo.so.2',          apt: 'libcairo2',          dnf: 'cairo',          pacman: 'cairo',         zypper: 'cairo' },
  { soname: 'libpixman-1.so.0',       apt: 'libpixman-1-0',      dnf: 'pixman',         pacman: 'pixman',        zypper: 'libpixman-1-0' },
  { soname: 'libfontconfig.so.1',     apt: 'libfontconfig1',     dnf: 'fontconfig',     pacman: 'fontconfig',    zypper: 'fontconfig' },
  { soname: 'libfreetype.so.6',       apt: 'libfreetype6',       dnf: 'freetype',       pacman: 'freetype2',     zypper: 'libfreetype6' },
  { soname: 'libpng16.so.16',         apt: 'libpng16-16',        dnf: 'libpng',         pacman: 'libpng',        zypper: 'libpng16-16' },
  { soname: 'libatk-1.0.so.0',        apt: 'libatk1.0-0',        dnf: 'atk',            pacman: 'atk',           zypper: 'libatk-1_0-0' },
  { soname: 'libatk-bridge-2.0.so.0', apt: 'libatk-bridge2.0-0', dnf: 'at-spi2-atk',     pacman: 'at-spi2-atk',   zypper: 'at-spi2-atk' },
  { soname: 'libX11.so.6',            apt: 'libx11-6',           dnf: 'libX11',         pacman: 'libx11',        zypper: 'libX11-6' },
  { soname: 'libxcb.so.1',            apt: 'libxcb1',            dnf: 'libxcb',         pacman: 'libxcb',        zypper: 'libxcb1' },
  { soname: 'libxcb-render.so.0',     apt: 'libxcb-render0',     dnf: 'libxcb',         pacman: 'libxcb',        zypper: 'libxcb-render0' },
  { soname: 'libxcb-shm.so.0',        apt: 'libxcb-shm0',        dnf: 'libxcb',         pacman: 'libxcb',        zypper: 'libxcb-shm0' },
  { soname: 'libXext.so.6',           apt: 'libxext6',           dnf: 'libXext',        pacman: 'libxext',       zypper: 'libXext6' },
  { soname: 'libXfixes.so.3',         apt: 'libxfixes3',         dnf: 'libXfixes',      pacman: 'libxfixes',     zypper: 'libXfixes3' },
  { soname: 'libglib-2.0.so.0',       apt: 'libglib2.0-0',       dnf: 'glib2',          pacman: 'glib2',         zypper: 'libglib-2_0-0' },
  { soname: 'libnspr4.so',            apt: 'libnspr4',           dnf: 'nspr',           pacman: 'nspr',          zypper: 'mozilla-nspr' },
  { soname: 'libdbus-1.so.3',         apt: 'libdbus-1-3',        dnf: 'dbus-libs',      pacman: 'dbus',          zypper: 'dbus-1' },
  { soname: 'libexpat.so.1',          apt: 'libexpat1',          dnf: 'expat',          pacman: 'expat',         zypper: 'libexpat1' },
];

function detectPM() {
  let id = '', like = '';
  try {
    const osr = fs.readFileSync('/etc/os-release', 'utf8');
    for (const line of osr.split('\n')) {
      const m = line.match(/^(ID|ID_LIKE)=(.*)$/);
      if (m) { const v = m[2].replace(/"/g, '').trim(); if (m[1] === 'ID') id = v; else like = v; }
    }
  } catch {}
  const hay = (id + ' ' + like).toLowerCase();
  const which = (cmd) => { try { return fs.existsSync('/usr/bin/' + cmd) || fs.existsSync('/bin/' + cmd) || fs.existsSync('/usr/sbin/' + cmd); } catch { return false; } };
  if (/debian|ubuntu|kali|linuxmint|pop|raspbian/.test(hay) || which('apt-get')) return 'apt';
  if (/fedora|rhel|centos|rocky|alma|oracle/.test(hay) || which('dnf')) return 'dnf';
  if (/arch|manjaro|endeavouros/.test(hay) || which('pacman')) return 'pacman';
  if (/suse|opensuse/.test(hay) || which('zypper')) return 'zypper';
  return null;
}

function installCmd(pkgs, pm) {
  const list = pkgs.join(' ');
  if (pm === 'apt') return `sudo apt-get update && for p in ${list}; do sudo apt-get install -y "$p" || sudo apt-get install -y "\${p}t64" || echo "could not install $p"; done`;
  if (pm === 'dnf') return `sudo dnf install -y ${list}`;
  if (pm === 'pacman') return `sudo pacman -S --noconfirm ${list}`;
  if (pm === 'zypper') return `sudo zypper install -y ${list}`;
  return null;
}

function checkDeps() {
  return new Promise((resolve) => {
    const tryNext = (paths) => {
      if (!paths.length) return resolve({ missing: [], packages: [], pm: detectPM(), command: null, ldconfigOk: false });
      execFile(paths[0], ['-p'], { timeout: 15000 }, (err, out) => {
        if (err && err.code === 'ENOENT') return tryNext(paths.slice(1));
        const text = out || '';
        const pm = detectPM();
        const missing = [];
        for (const d of DEPS) {
          // ldconfig lines look like: "\tlibgtk-3.so.0 (libc6,x86-64) => /usr/lib/.../libgtk-3.so.0"
          if (!text.includes(d.soname)) missing.push(d);
        }
        const pkgs = [...new Set(missing.map(d => (pm && d[pm]) || d.apt))];
        resolve({
          missing: missing.map(d => d.soname),
          packages: pkgs,
          pm,
          command: pkgs.length ? installCmd(pkgs, pm) : null,
          ldconfigOk: !err,
        });
      });
    };
    // ldconfig lives in /sbin on many distros — not always in a GUI app's PATH
    tryNext(['ldconfig', '/sbin/ldconfig', '/usr/sbin/ldconfig']);
  });
}

module.exports = { DEPS, detectPM, installCmd, checkDeps };
