// Rogue — cyber agent workstation shell
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut } = require('electron');
// VMs and broken GPU drivers make Chromium's GPU process crash-loop and eat
// CPU (virtio-gpu "SharedImage failed" spam). This shell is a text UI —
// software rendering is plenty and works everywhere.
app.disableHardwareAcceleration();
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const https = require('https');
const http = require('http');
const deps = require('./deps');

let mainWin = null;
let tray = null;
function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message || '').trim().slice(0, 300))) : resolve(stdout || ''));
  });
}
let ocProc = null;
let ocPort = 0;
let ocDir = os.homedir();

// ================= settings =================
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings() {
  try {
    return Object.assign(
      { recentFolders: [], autoBoot: false, minimizeToTray: true, lastFolder: null, socialLinks: { github: '', instagram: '', youtube: '', website: '' } },
      JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    );
  } catch { return { recentFolders: [], autoBoot: false, minimizeToTray: true, lastFolder: null, socialLinks: { github: '', instagram: '', youtube: '', website: '' } }; }
}
function saveSettings(s) {
  try { fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); } catch {}
}
function pushRecentFolder(dir) {
  if (!dir) return;
  const s = loadSettings();
  s.recentFolders = [dir, ...s.recentFolders.filter(d => d !== dir)].slice(0, 6);
  saveSettings(s);
}

// ================= opencode engine =================
// FIXED port: the web UI keeps its state (model toggles, projects, prefs) in
// browser localStorage, which is scoped per origin (host+port). A random port
// every launch = a fresh origin = the UI "forgetting" everything.
const OC_PORT = 18789;
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
// true if an opencode server answers on this port
function probeOpencode(port) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: '/session', timeout: 3000 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}
// claim our fixed port: free -> use it; our own zombie -> SIGTERM it; foreign -> null
async function claimPort(port) {
  if (await probeOpencode(port)) {
    try {
      let pid = 0;
      const out = await execFileP('sh', ['-c', `lsof -ti:${port} 2>/dev/null | head -1; true`]);
      pid = parseInt(String(out).trim().split('\n')[0], 10);
      if (!pid || isNaN(pid)) { // lsof missing or empty — fall back to matching the serve command line
        const out2 = await execFileP('sh', ['-c', `pgrep -f "opencode serv[e] --port ${port}" 2>/dev/null | head -1; true`]);
        pid = parseInt(String(out2).trim().split('\n')[0], 10);
      }
      if (pid > 1 && pid !== process.pid) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch {}
    if (await probeOpencode(port)) return null; // survived — not ours to kill
    return port;
  }
  const busy = await new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(true));
    s.once('listening', () => s.close(() => res(false)));
    s.listen(port, '127.0.0.1');
  });
  return busy ? null : port;
}
function findOpencodeBinary() {
  const cands = [
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
    '/usr/local/bin/opencode', '/usr/bin/opencode',
    path.join(os.homedir(), '.local', 'bin', 'opencode'),
  ];
  for (const c of cands) { try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}
function linuxOpencodeAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!arch) throw new Error('Unsupported CPU: ' + process.arch);
  let baseline = false;
  if (arch === 'x64') { try { baseline = !/avx2/i.test(fs.readFileSync('/proc/cpuinfo', 'utf8')); } catch { baseline = false; } }
  return `opencode-linux-${arch}${baseline ? '-baseline' : ''}.tar.gz`;
}
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'rogue' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); return downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) { file.close(); return reject(new Error('Download failed: HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let done = 0;
      res.on('data', d => { done += d.length; if (onProgress && total) onProgress({ done, total, pct: Math.round(done / total * 100) }); });
      res.on('aborted', () => { file.close(); try { fs.unlinkSync(dest); } catch {} reject(new Error('Download interrupted — retry')); });
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        // partial file saved as "complete" is how corrupt AppImages happen — refuse it
        if (total > 0 && done < total) { try { fs.unlinkSync(dest); } catch {} return reject(new Error(`Incomplete download (${done}/${total} bytes) — retry`)); }
        resolve(dest);
      });
    });
    req.on('error', e => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}
function elfCheck(p) {
  // null = OK, otherwise a human-readable reason. Catches truncated downloads
  // AND wrong-architecture files (e.g. an ARM64 AppImage on an x86-64 PC).
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 1024 * 1024) return 'file too small / damaged';
    const fd = fs.openSync(p, 'r');
    try {
      const h = Buffer.alloc(64);
      if (fs.readSync(fd, h, 0, 64, 0) < 64) return 'file too small / damaged';
      if (h[0] !== 0x7f || h[1] !== 0x45 || h[2] !== 0x4c || h[3] !== 0x46) return 'not a real AppImage (bad file header)';
      const machine = h.readUInt16LE(0x12); // e_machine
      const want = process.arch === 'x64' ? 0x3E : process.arch === 'arm64' ? 0xB7 : null;
      if (want && machine !== want) {
        const nameOf = m => m === 0xB7 ? 'ARM64' : m === 0x3E ? 'x86-64' : 'unknown CPU';
        return `wrong architecture: file is ${nameOf(machine)}, this PC is ${nameOf(want)}`;
      }
      return null;
    } finally { try { fs.closeSync(fd); } catch {} }
  } catch (e) { return e.message; }
}
function downloadOpencodeBinary(sender) {
  return new Promise(async (resolve, reject) => {
    try {
      const asset = linuxOpencodeAsset();
      const url = `https://github.com/anomalyco/opencode/releases/latest/download/${asset}`;
      const tmp = path.join(os.tmpdir(), `rogue-opencode-${Date.now()}.tar.gz`);
      const say = (stage, pct, text) => { try { sender.send('engine:progress', { stage, pct, text }); } catch {} };
      say('download', 0, 'downloading opencode engine…');
      await downloadFile(url, tmp, p => say('download', p.pct, `downloading opencode engine… ${p.pct}%`));
      say('extract', 100, 'extracting engine…');
      const binDir = path.join(os.homedir(), '.opencode', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      await new Promise((res, rej) => execFile('tar', ['-xzf', tmp, '-C', binDir], err => err ? rej(new Error('extract failed: ' + err.message)) : res()));
      try { fs.unlinkSync(tmp); } catch {}
      const bin = path.join(binDir, 'opencode');
      if (!fs.existsSync(bin)) throw new Error('Engine binary missing after extract.');
      fs.chmodSync(bin, 0o755);
      resolve(bin);
    } catch (e) { reject(e); }
  });
}
function waitForHttp(port, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, res => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      r.on('error', retry);
      r.on('timeout', () => { r.destroy(); retry(); });
      function retry() {
        if (Date.now() - start > timeoutMs) return reject(new Error('OpenCode server did not start in time.'));
        setTimeout(tick, 500);
      }
    };
    tick();
  });
}
function binaryProblem(bin) {
  // null = looks runnable, otherwise a short reason. Uses the same ELF checks
  // as the AppImage validator (magic + size + architecture).
  try {
    const st = fs.statSync(bin);
    if (!st.isFile()) return 'not a file';
    if (!(st.mode & 0o111)) return 'not executable';
    const r = elfCheck(bin);
    if (r) return r;
    return null;
  } catch (e) { return e.message; }
}
async function ensureOpencodeServer(dir, sender) {
  if (ocProc && ocPort) {
    if (dir && dir !== ocDir) stopOpencodeServer(); // folder changed -> reboot in the new folder
    else return { url: `http://127.0.0.1:${ocPort}` };
  }
  const say = (stage, pct, text) => { try { sender && sender.send('engine:progress', { stage, pct, text }); } catch {} };
  // the working folder must exist — a missing cwd makes spawn() fail with a
  // misleading ENOENT that blames the binary
  ocDir = dir || os.homedir();
  if (!fs.existsSync(ocDir)) { say('check', 0, `working folder not found (${ocDir}) — using home folder instead`); ocDir = os.homedir(); }
  let bin = findOpencodeBinary();
  const problem = bin ? binaryProblem(bin) : 'not installed';
  if (problem) {
    say('check', 0, bin ? `engine unusable (${problem}) — downloading a fresh copy…` : 'opencode engine not found — downloading…');
    // a broken copy under our own engine folder gets removed so the fresh one takes its place
    if (bin && bin.startsWith(path.join(os.homedir(), '.opencode'))) { try { fs.unlinkSync(bin); } catch {} }
    bin = await downloadOpencodeBinary(sender);
    const p2 = binaryProblem(bin);
    if (p2) throw new Error('Downloaded engine is not usable: ' + p2);
  }
  // engine output goes to a log file: undrained pipes can block the server,
  // and on failure the log tail tells us the REAL reason it died
  const ocLogFile = path.join(os.tmpdir(), 'rogue-opencode.log');
  const readLogTail = () => {
    try {
      return fs.readFileSync(ocLogFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    } catch { return ''; }
  };
  const bootAttempt = async () => {
    // stable port keeps the web UI's localStorage (models, projects, prefs) alive across restarts
    ocPort = (await claimPort(OC_PORT)) || (await claimPort(OC_PORT + 1)) || (await getFreePort());
    if (ocPort !== OC_PORT) say('boot', 50, `port ${OC_PORT} busy — using ${ocPort} (UI prefs may reset)`);
    say('boot', 100, 'starting opencode server…');
    let logFd = null;
    try { logFd = fs.openSync(ocLogFile, 'w'); } catch {}
    ocProc = spawn(bin, ['serve', '--port', String(ocPort), '--hostname', '127.0.0.1'], { cwd: ocDir, stdio: ['ignore', logFd === null ? 'ignore' : logFd, logFd === null ? 'ignore' : logFd] });
    if (logFd !== null) { try { fs.closeSync(logFd); } catch {} }
    // CRITICAL: a failed spawn emits an 'error' event; with no listener Node turns
    // it into an uncaught exception and the whole app shows a crash dialog.
    const spawnFailed = new Promise((_, rej) => ocProc.once('error', rej));
    const diedEarly = new Promise((_, rej) => ocProc.once('exit', code => rej(new Error(`engine exited during startup (code ${code})`))));
    ocProc.on('exit', () => { ocProc = null; ocPort = 0; });
    try {
      await Promise.race([waitForHttp(ocPort), spawnFailed, diedEarly]);
    } catch (e) {
      stopOpencodeServer();
      const tail = readLogTail();
      throw new Error('Engine failed to start: ' + e.message + (tail ? ' — engine said: ' + tail.slice(0, 400) : ''));
    }
    say('live', 100, 'engine live');
    pushRecentFolder(ocDir);
    return { url: `http://127.0.0.1:${ocPort}` };
  };
  try {
    return await bootAttempt();
  } catch (e1) {
    // ---- self-heal: known, fixable engine-database failures get ONE automatic repair + retry ----
    const log = readLogTail();
    const dbFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    if (/no session table|database is not empty|malformed/i.test(log) && fs.existsSync(dbFile)) {
      // damaged database (bad copy / interrupted migration): move it aside as a
      // backup — never delete — and let the engine create a fresh one.
      // API keys live in auth.json and are NOT touched.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const suf of ['', '-wal', '-shm']) {
        try { if (fs.existsSync(dbFile + suf)) fs.renameSync(dbFile + suf, `${dbFile}.broken-${stamp}${suf}`); } catch {}
      }
      say('check', 0, 'damaged engine database found — backed up and starting fresh (your API keys are untouched)…');
      return await bootAttempt();
    }
    if (/database is locked/i.test(log)) {
      // a leftover engine from an older run holds the database — clear it and retry
      say('check', 0, 'an old engine process is holding the database — clearing it and retrying…');
      try { await execFileP('sh', ['-c', 'pkill -f "opencode serv[e]" 2>/dev/null; true']); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      return await bootAttempt();
    }
    throw e1;
  }
}
function stopOpencodeServer() { if (ocProc) { try { ocProc.kill('SIGTERM'); } catch {} ocProc = null; ocPort = 0; } }
function engineVersion() {
  return new Promise(resolve => {
    const bin = findOpencodeBinary();
    if (!bin) return resolve(null);
    execFile(bin, ['--version'], { timeout: 15000 }, (err, out) => {
      if (err) return resolve(null);
      const m = String(out).match(/(\d+\.\d+\.\d+)/);
      resolve(m ? m[1] : String(out).trim().slice(0, 20));
    });
  });
}
// local server REST helper
function serverJson(method, p, body) {
  return new Promise((resolve, reject) => {
    if (!ocPort) return reject(new Error('engine not running'));
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: ocPort, path: p, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('server request timed out')); });
    if (data) req.write(data);
    req.end();
  });
}

// ================= opencode.json config =================
const OCODE_CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode', 'opencode.json');
function readOpencodeConfig() {
  try { const j = JSON.parse(fs.readFileSync(OCODE_CONFIG, 'utf8')); return (typeof j === 'object' && j !== null) ? j : {}; }
  catch { return {}; }
}
function writeOpencodeConfig(cfg) {
  fs.mkdirSync(path.dirname(OCODE_CONFIG), { recursive: true });
  const out = Object.assign({ $schema: 'https://opencode.ai/config.json' }, cfg);
  fs.writeFileSync(OCODE_CONFIG, JSON.stringify(out, null, 2));
  try { fs.chmodSync(OCODE_CONFIG, 0o600); } catch {}
}

// ================= auth (setup wizard) =================
// OpenCode reads keys from auth.json, from environment variables AND from
// provider blocks in opencode.json — a key that "works" in OpenCode may live
// in any of the three. The app must see all of them, not just auth.json.
const AUTH_PATH = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json');
// env var (from OpenCode's provider catalog) -> provider id
const ENV_PROVIDERS = {
  GROQ_API_KEY: 'groq', OPENAI_API_KEY: 'openai', ANTHROPIC_API_KEY: 'anthropic',
  GOOGLE_GENERATIVE_AI_API_KEY: 'google', GEMINI_API_KEY: 'google',
  DEEPSEEK_API_KEY: 'deepseek', MISTRAL_API_KEY: 'mistral',
  OPENROUTER_API_KEY: 'openrouter', XAI_API_KEY: 'xai', COHERE_API_KEY: 'cohere',
  TOGETHER_API_KEY: 'togetherai', CEREBRAS_API_KEY: 'cerebras',
  MOONSHOT_API_KEY: 'moonshotai', DASHSCOPE_API_KEY: 'alibaba',
  OLLAMA_API_KEY: 'ollama-cloud', OPENCODE_API_KEY: 'opencode',
  ZHIPU_API_KEY: 'zai', CHUTES_API_KEY: 'chutes',
  NEBIUS_API_KEY: 'nebius', DEEPINFRA_API_KEY: 'deepinfra',
};
function listProviders() {
  const set = new Set(Object.keys(readAuthFile()));
  for (const [env, id] of Object.entries(ENV_PROVIDERS)) {
    if (process.env[env]) set.add(id);
  }
  try { for (const id of Object.keys(readOpencodeConfig().provider || {})) set.add(id); } catch {}
  set.add('opencode'); // free Zen models — always available, no key needed
  return [...set].sort();
}
function readAuthFile() {
  try { const j = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); return (typeof j === 'object' && j !== null) ? j : {}; }
  catch { return {}; }
}

// ================= terminal (node-pty) =================
let ptyMod = null;
try { ptyMod = require('node-pty'); } catch (e) { console.error('node-pty unavailable:', e.message); }
const terms = new Map(); let termSeq = 0;

// ================= window / tray =================
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1024, minHeight: 640,
    backgroundColor: '#0a0a0f', title: 'Rogue',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(path.join(__dirname, 'ui', 'shell.html'));
  mainWin.on('close', (e) => {
    if (loadSettings().minimizeToTray && !app.quitting) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
}
function setupTray() {
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon.png'));
    tray.setToolTip('Rogue');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Rogue', click: () => mainWin && mainWin.show() },
      { label: 'Enter OpenCode', click: () => { if (mainWin) { mainWin.show(); mainWin.webContents.send('tray:open-opencode'); } } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('click', () => mainWin && mainWin.show());
  } catch (e) { console.error('tray failed:', e.message); }
}

// ================= IPC =================
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'], defaultPath: ocDir });
  return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});
ipcMain.handle('settings:get', async () => ({ ok: true, settings: loadSettings() }));
ipcMain.handle('settings:set', async (_e, patch) => {
  const s = Object.assign(loadSettings(), patch || {});
  saveSettings(s); registerHotkey(); return { ok: true, settings: s };
});

// global hotkey: Ctrl+Alt+A toggles the window from anywhere
function registerHotkey() {
  try { globalShortcut.unregisterAll(); } catch {}
  if (loadSettings().globalHotkey === false) return;
  try {
    globalShortcut.register('CommandOrControl+Alt+A', () => {
      if (!mainWin) return;
      if (mainWin.isVisible()) mainWin.hide(); else { mainWin.show(); mainWin.focus(); }
    });
  } catch {}
}

ipcMain.handle('opencode:ensure', async (e, dir) => {
  try { return { ok: true, ...(await ensureOpencodeServer(dir, e.sender)) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('opencode:stop', async () => { stopOpencodeServer(); return { ok: true }; });
ipcMain.handle('opencode:alive', async () => ({ ok: true, alive: !!(ocProc && ocPort), port: ocPort }));
ipcMain.handle('engine:version', async () => ({ ok: true, version: await engineVersion() }));
ipcMain.handle('app:version', async () => ({ ok: true, version: require('electron').app.getVersion() }));
ipcMain.handle('engine:upgrade', async (e) => {
  const bin = findOpencodeBinary();
  if (!bin) return { ok: false, error: 'Engine not installed yet.' };
  stopOpencodeServer();
  return new Promise((resolve) => {
    const say = (t) => { try { e.sender.send('engine:upgrade-log', t); } catch {} };
    say('⏳ upgrading opencode engine…\n');
    const child = spawn(bin, ['upgrade'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; say(d.toString()); });
    child.stderr.on('data', d => { out += d; say(d.toString()); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} say('\n✖ timed out after 5 minutes.'); resolve({ ok: false, error: 'Upgrade timed out.' }); }, 300000);
    child.on('close', code => {
      clearTimeout(timer);
      say(code === 0 ? '\n✓ upgrade finished. Restart the engine to use it.' : `\n✖ exited with code ${code}`);
      resolve({ ok: code === 0 });
    });
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
  });
});
ipcMain.handle('engine:stats', async (_e, days) => {
  const bin = findOpencodeBinary();
  if (!bin) return { ok: false, error: 'Engine not installed yet.' };
  return new Promise((resolve) => {
    execFile(bin, ['stats', '--days', String(days || 30)], { timeout: 60000 }, (err, out) => {
      if (err) return resolve({ ok: false, error: 'Could not read stats.' });
      const clean = String(out).split('\n').map(l => l.replace(/[│┌┐└┘├┤┬┴┼─]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
      const val = (label) => { const l = clean.find(x => x.toLowerCase().startsWith(label.toLowerCase() + ' ')); return l ? l.slice(label.length).trim() : null; };
      resolve({
        ok: true,
        stats: {
          sessions: val('Sessions'), messages: val('Messages'), days: val('Days'),
          cost: val('Total Cost'), avgCostDay: val('Avg Cost/Day'),
          input: val('Input'), output: val('Output'),
          cacheRead: val('Cache Read'), cacheWrite: val('Cache Write'),
        },
      });
    });
  });
});
ipcMain.handle('engine:models', async (_e, provider) => {
  const bin = findOpencodeBinary();
  if (!bin) return { ok: false, error: 'Engine not installed yet.' };
  return new Promise((resolve) => {
    execFile(bin, ['models', provider], { timeout: 60000 }, (err, out) => {
      if (err) return resolve({ ok: false, error: 'Provider not found. Connect its key first.' });
      const models = String(out).split('\n').map(s => s.trim()).filter(s => s.includes('/'));
      resolve({ ok: true, models });
    });
  });
});

ipcMain.handle('auth:list', async () => ({ ok: true, providers: listProviders() }));
// Configured providers, from the live engine when it is running (ground
// truth: the server's /provider list marks a provider configured when its
// source is api/env/config — 'custom' means "in the catalog, no key").
// Falls back to the merged auth.json + env + config list when the engine is down.
ipcMain.handle('provider:configured', async () => {
  const fallback = () => ({ ok: true, live: false, providers: listProviders().map(id => ({ id, models: null })) });
  if (!(ocProc && ocPort)) return fallback();
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: ocPort, path: '/provider', timeout: 8000 }, res => {
        let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b));
      });
      req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    const all = (JSON.parse(body).all) || [];
    const providers = all
      .filter(p => p.source && p.source !== 'custom')
      .map(p => ({ id: p.id, models: Object.keys(p.models || {}) }));
    if (!providers.some(p => p.id === 'opencode')) providers.push({ id: 'opencode', models: Object.keys((all.find(p => p.id === 'opencode') || {}).models || {}) });
    return { ok: true, live: true, providers: providers.sort((a, b) => a.id.localeCompare(b.id)) };
  } catch { return fallback(); }
});
ipcMain.handle('auth:save', async (_e, providerId, key) => {
  const id = String(providerId || '').trim().toLowerCase();
  const k = String(key || '').trim();
  if (!/^[a-z0-9_-]{2,40}$/.test(id)) return { ok: false, error: 'Invalid provider.' };
  if (k.length < 8) return { ok: false, error: 'Key looks too short.' };
  try {
    const a = readAuthFile(); a[id] = { type: 'api', key: k };
    fs.mkdirSync(path.dirname(AUTH_PATH), { recursive: true });
    fs.writeFileSync(AUTH_PATH, JSON.stringify(a, null, 2), { mode: 0o600 });
    return { ok: true, providers: listProviders() };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('auth:remove', async (_e, providerId) => {
  const id = String(providerId || '').trim().toLowerCase();
  try {
    const a = readAuthFile(); delete a[id];
    fs.writeFileSync(AUTH_PATH, JSON.stringify(a, null, 2), { mode: 0o600 });
    return { ok: true, providers: listProviders() };
  } catch (e) { return { ok: false, error: e.message }; }
});

// opencode.json: default model, mcp, plugins, ollama
ipcMain.handle('config:get', async () => ({ ok: true, config: readOpencodeConfig() }));
ipcMain.handle('config:setModel', async (_e, model) => {
  try {
    const c = readOpencodeConfig();
    if (model) c.model = model; else delete c.model;
    writeOpencodeConfig(c);
    return { ok: true, model: c.model || null };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mcp:add', async (_e, spec) => {
  try {
    const { name, type, command, url, env, enabled } = spec || {};
    const n = String(name || '').trim();
    if (!/^[a-zA-Z0-9_-]{2,40}$/.test(n)) return { ok: false, error: 'Name: 2-40 chars, letters/numbers/_/-.' };
    const c = readOpencodeConfig(); c.mcp = c.mcp || {};
    if (type === 'remote') {
      if (!/^https?:\/\/.+/.test(String(url || ''))) return { ok: false, error: 'Remote needs an http(s) URL.' };
      c.mcp[n] = { type: 'remote', url: String(url).trim(), enabled: enabled !== false };
    } else {
      const cmd = String(command || '').trim().split(/\s+/).filter(Boolean);
      if (!cmd.length) return { ok: false, error: 'Command required, e.g. "npx -y @modelcontextprotocol/server-everything".' };
      const entry = { type: 'local', command: cmd, enabled: enabled !== false };
      const envObj = {};
      String(env || '').split('\n').forEach(line => {
        const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m) envObj[m[1]] = m[2];
      });
      if (Object.keys(envObj).length) entry.environment = envObj;
      c.mcp[n] = entry;
    }
    writeOpencodeConfig(c);
    return { ok: true, mcp: c.mcp };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mcp:remove', async (_e, name) => {
  try { const c = readOpencodeConfig(); if (c.mcp) delete c.mcp[name]; writeOpencodeConfig(c); return { ok: true, mcp: c.mcp || {} }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mcp:toggle', async (_e, name, enabled) => {
  try {
    const c = readOpencodeConfig();
    if (!c.mcp || !c.mcp[name]) return { ok: false, error: 'Not found.' };
    c.mcp[name].enabled = !!enabled; writeOpencodeConfig(c);
    return { ok: true, mcp: c.mcp };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('plugin:install', async (e, name) => {
  const mod = String(name || '').trim();
  if (!/^[a-zA-Z0-9@/_.-]{2,120}$/.test(mod)) return { ok: false, error: 'Invalid module name.' };
  const bin = findOpencodeBinary();
  if (!bin) return { ok: false, error: 'Engine not installed yet.' };
  return new Promise((resolve) => {
    const say = (t) => { try { e.sender.send('plugin:log', t); } catch {} };
    say(`⏳ installing ${mod} …\n`);
    const child = spawn(bin, ['plugin', mod, '-g'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => say(d.toString()));
    child.stderr.on('data', d => say(d.toString()));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ ok: false, error: 'Timed out.' }); }, 180000);
    child.on('close', code => { clearTimeout(timer); say(code === 0 ? '\n✓ installed.' : `\n✖ exit ${code}`); resolve({ ok: code === 0 }); });
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
  });
});
ipcMain.handle('ollama:status', async () => {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 5000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => {
        try { const j = JSON.parse(b); resolve({ ok: true, running: true, models: (j.models || []).map(m => m.name) }); }
        catch { resolve({ ok: true, running: false, models: [] }); }
      });
    });
    req.on('error', () => resolve({ ok: true, running: false, models: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: true, running: false, models: [] }); });
  });
});
ipcMain.handle('ollama:connect', async () => {
  try {
    const models = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 5000 }, res => {
        let b = ''; res.on('data', d => b += d);
        res.on('end', () => { try { resolve((JSON.parse(b).models || []).map(m => m.name)); } catch { resolve([]); } });
      });
      req.on('error', () => resolve([])); req.on('timeout', () => { req.destroy(); resolve([]); });
    });
    if (!models.length) return { ok: false, error: 'Ollama is not running or has no models. Start ollama first.' };
    const c = readOpencodeConfig(); c.provider = c.provider || {};
    const ms = {};
    models.forEach(m => { ms[m] = { name: m }; });
    c.provider.ollama = { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://localhost:11434/v1' }, models: ms };
    writeOpencodeConfig(c);
    return { ok: true, models: models.map(m => 'ollama/' + m) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// hunter agent (white-hat security auditor preset)
const HUNTER_MD = `---
description: Offensive-security code auditor for AUTHORIZED targets — finds vulnerabilities, suggests fixes, never attacks out of scope
mode: subagent
temperature: 0.2
tools:
  write: false
  edit: false
---

You are a senior application-security auditor working ONLY on targets the user is authorized to test (their own code, bug-bounty programs in scope, labs).

Rules:
- NEVER attack, exploit, or scan systems outside the user's stated scope. If scope is unclear, ask first.
- When auditing code: map findings to OWASP Top 10 / CWE IDs, rate severity (Critical/High/Medium/Low), show the vulnerable lines, explain the exploit scenario briefly, and give a concrete fix.
- When asked for payloads or PoCs: provide them ONLY for authorized testing, and always pair them with the remediation.
- Prefer static analysis first; suggest dynamic verification steps the user can run themselves.
- Be concise and structured: Findings table first, details after. No fluff.
`;
const HUNTER_PATH = path.join(os.homedir(), '.config', 'opencode', 'agents', 'hunter.md');
ipcMain.handle('hunter:status', async () => ({ ok: true, installed: fs.existsSync(HUNTER_PATH) }));
ipcMain.handle('hunter:install', async () => {
  try { fs.mkdirSync(path.dirname(HUNTER_PATH), { recursive: true }); fs.writeFileSync(HUNTER_PATH, HUNTER_MD); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('hunter:remove', async () => {
  try { if (fs.existsSync(HUNTER_PATH)) fs.unlinkSync(HUNTER_PATH); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// prompt library -> send to the session the user is actually looking at
async function waitForEngine(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const h = await serverJson('GET', '/global/health'); if (h && h.healthy) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
ipcMain.handle('prompt:send', async (_e, text) => {
  if (!ocProc || !ocPort) return { ok: false, error: 'Engine not running — boot OpenCode first.' };
  if (!(await waitForEngine())) return { ok: false, error: 'Engine is still starting — try again in a few seconds.' };
  try {
    // The embedded web UI only ever shows the session it has open — a brand
    // new session every time left the prompt invisible in the sidebar. So
    // send to the most recent session in the current folder (the chat the
    // user is looking at, live-updated via the server event stream) and only
    // start a new session when there is none yet.
    let target = null, isNew = false;
    try {
      const list = await serverJson('GET', '/session');
      const sessions = Array.isArray(list) ? list : (list && list.data) || [];
      const mine = sessions.filter(s => (s.directory || (s.location && s.location.directory)) === ocDir);
      mine.sort((a, b) => ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0));
      target = mine[0] || null;
    } catch {}
    if (!target) {
      const s = await serverJson('POST', '/session', {});
      if (!s || !s.id) return { ok: false, error: 'Could not create a session' + (s && s.error ? ': ' + s.error : '.') };
      target = s; isNew = true;
    }
    // The message endpoint streams the assistant's reply, so its response
    // stays open while the model works — awaiting it would time out even
    // though the prompt landed. Fire it, then verify the message actually
    // appears in the session (that is what "sent" has to mean).
    serverJson('POST', `/session/${target.id}/message`, { parts: [{ type: 'text', text: String(text) }] }).catch(() => null);
    const deadline = Date.now() + 10000;
    let landed = false;
    while (Date.now() < deadline) {
      try {
        const msgs = await serverJson('GET', `/session/${target.id}/message`);
        const list = Array.isArray(msgs) ? msgs : (msgs && msgs.data) || [];
        const lastUser = [...list].reverse().find(m => m.info && m.info.role === 'user');
        const tp = lastUser && lastUser.parts && lastUser.parts.find(p => p.type === 'text');
        if (tp && tp.text === String(text)) { landed = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    if (!landed) return { ok: false, error: 'OpenCode did not accept the prompt — try again.' };
    return { ok: true, sessionId: target.id, isNew };
  } catch (e) { return { ok: false, error: e.message }; }
});

// sessions: full history — persists in ~/.local/share/opencode until user deletes
ipcMain.handle('sessions:list', async () => {
  // live engine: rich data incl. directory
  if (ocProc && ocPort) {
    try {
      const r = await serverJson('GET', '/session');
      const list = (Array.isArray(r) ? r : []).map(s => ({
        id: s.id, title: s.title || 'untitled',
        directory: s.directory || '', created: s.time && s.time.created ? s.time.created : null,
        source: 'engine',
      }));
      return { ok: true, sessions: list };
    } catch {}
  }
  // fallback: CLI (works with engine off)
  try {
    const bin = findOpencodeBinary();
    if (!bin) throw new Error('opencode engine not installed yet');
    const out = await execFileP(bin, ['session', 'list']);
    const sessions = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^(ses_[A-Za-z0-9]+)\s+(.*?)\s{2,}(.+)$/);
      if (m) sessions.push({ id: m[1], title: m[2].trim(), updated: m[3].trim(), directory: '', source: 'cli' });
    }
    return { ok: true, sessions };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('sessions:delete', async (_e, id) => {
  if (!id || !/^ses_[A-Za-z0-9]+$/.test(id)) return { ok: false, error: 'bad session id' };
  if (ocProc && ocPort) {
    try { await serverJson('DELETE', '/session/' + id); return { ok: true }; } catch {}
  }
  try {
    const bin = findOpencodeBinary();
    if (!bin) throw new Error('opencode engine not installed yet');
    await execFileP(bin, ['session', 'delete', id]);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// sessions backup
function doBackup(destDir) {
  const dest = path.join(destDir, `rogue-backup-${new Date().toISOString().slice(0, 10)}`);
  fs.mkdirSync(dest, { recursive: true });
  const src = path.join(os.homedir(), '.local', 'share', 'opencode');
  if (fs.existsSync(src)) for (const f of fs.readdirSync(src)) {
    if (f.startsWith('opencode.db') || f === 'log') {
      const s = path.join(src, f), d = path.join(dest, f);
      if (fs.statSync(s).isDirectory()) fs.cpSync(s, d, { recursive: true }); else fs.copyFileSync(s, d);
    }
  }
  if (fs.existsSync(OCODE_CONFIG)) fs.copyFileSync(OCODE_CONFIG, path.join(dest, 'opencode.json'));
  fs.writeFileSync(path.join(dest, 'README.txt'), 'Rogue backup.\nNOTE: API keys (auth.json) are NOT included — reconnect providers after restore.\n');
  return dest;
}
ipcMain.handle('sessions:backup', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return { ok: false, error: 'cancelled' };
  try { return { ok: true, path: doBackup(r.filePaths[0]) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('backup:pickdir', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return { ok: false, error: 'cancelled' };
  return { ok: true, path: r.filePaths[0] };
});
ipcMain.handle('backup:auto', async () => {
  const s = loadSettings();
  if (!s.backupEnabled || !s.backupDir) return { ok: false, error: 'auto-backup not configured' };
  try {
    const p = doBackup(s.backupDir);
    s.lastBackup = Date.now(); saveSettings(s);
    return { ok: true, path: p };
  } catch (e) { return { ok: false, error: e.message }; }
});

// session export -> markdown
ipcMain.handle('sessions:export', async (_e, id) => {
  if (!id || !/^ses_[A-Za-z0-9]+$/.test(id)) return { ok: false, error: 'Invalid session id.' };
  if (!ocProc || !ocPort) return { ok: false, error: 'Start the OpenCode engine first to export.' };
  try {
    const r = await serverJson('GET', '/session');
    const s = (Array.isArray(r) ? r : []).find(x => x.id === id) || {};
    const msgs = await serverJson('GET', `/session/${id}/message`);
    const lines = [`# ${s.title || 'Untitled session'}`, '', `Session: \`${id}\``];
    if (s.directory) lines.push(`Directory: \`${s.directory}\``);
    lines.push(`Exported: ${new Date().toISOString()}`, '', '---', '');
    for (const m of (Array.isArray(msgs) ? msgs : [])) {
      const info = m.info || {};
      const isA = info.role === 'assistant';
      const model = info.modelID || (info.model && info.model.modelID) || '';
      const ts = info.time && info.time.created ? new Date(info.time.created).toLocaleString() : '';
      lines.push(`## ${isA ? 'Assistant' : 'User'}${model ? ` (${model})` : ''}${ts ? ` — ${ts}` : ''}`, '');
      for (const p of (m.parts || [])) {
        if (p.type === 'text' && p.text) lines.push(p.text, '');
        else if (p.type) lines.push(`*[${p.type} part]*`, '');
      }
    }
    const defName = `${String(s.title || id).replace(/[^a-z0-9-_]+/gi, '-').slice(0, 40) || id}.md`;
    const dr = await dialog.showSaveDialog(mainWin, { defaultPath: defName, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (dr.canceled || !dr.filePath) return { ok: false, error: 'cancelled' };
    fs.writeFileSync(dr.filePath, lines.join('\n'));
    return { ok: true, path: dr.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

// custom agents manager (markdown files in ~/.config/opencode/agents/)
const AGENTS_DIR = path.join(os.homedir(), '.config', 'opencode', 'agents');
const safeAgentName = n => (/^[a-zA-Z0-9-_]{1,40}$/.test(n || '') ? n : null);
ipcMain.handle('agents:list', async () => {
  try {
    if (!fs.existsSync(AGENTS_DIR)) return { ok: true, agents: [] };
    return { ok: true, agents: fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('agents:read', async (_e, name) => {
  const n = safeAgentName(name); if (!n) return { ok: false, error: 'Invalid name.' };
  try { return { ok: true, content: fs.readFileSync(path.join(AGENTS_DIR, n + '.md'), 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('agents:save', async (_e, name, content) => {
  const n = safeAgentName(name);
  if (!n) return { ok: false, error: 'Name: letters, numbers, - and _ only (max 40 chars).' };
  try {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(AGENTS_DIR, n + '.md'), String(content || ''));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('agents:delete', async (_e, name) => {
  const n = safeAgentName(name); if (!n) return { ok: false, error: 'Invalid name.' };
  try { fs.unlinkSync(path.join(AGENTS_DIR, n + '.md')); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('term:available', async () => ({ available: !!ptyMod }));
ipcMain.handle('term:spawn', async (_e, cwd) => {
  if (!ptyMod) return { ok: false, error: 'terminal engine unavailable in this build.' };
  try {
    const id = ++termSeq;
    const p = ptyMod.spawn(process.env.SHELL || 'bash', [], {
      name: 'xterm-256color', cwd: (cwd && fs.existsSync(cwd)) ? cwd : os.homedir(),
      env: process.env, cols: 120, rows: 30,
    });
    terms.set(id, p);
    p.onData((d) => { if (mainWin) mainWin.webContents.send('term:data', { id, data: d }); });
    p.onExit(({ exitCode, signal }) => { terms.delete(id); if (mainWin) mainWin.webContents.send('term:exit', { id, exitCode, signal }); });
    return { ok: true, id };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('term:write', async (_e, id, data) => { const p = terms.get(id); if (p) p.write(data); return { ok: true }; });
ipcMain.handle('term:resize', async (_e, id, cols, rows) => { const p = terms.get(id); if (p && cols > 0 && rows > 0) p.resize(cols, rows); return { ok: true }; });
ipcMain.handle('term:kill', async (_e, id) => { const p = terms.get(id); if (p) try { p.kill(); } catch {} terms.delete(id); return { ok: true }; });

ipcMain.handle('window:close', async () => { if (mainWin) mainWin.close(); return { ok: true }; });
ipcMain.handle('folder:create', async (_e, name, dir) => {
  const base = (dir && fs.existsSync(dir)) ? dir : (ocDir || os.homedir());
  const clean = String(name || '').trim();
  if (!clean) return { ok: false, error: 'Enter a folder name.' };
  if (/[/\\]/.test(clean) || clean === '.' || clean === '..') return { ok: false, error: 'Use a plain folder name (no / or \\).' };
  const target = path.join(base, clean);
  try { fs.mkdirSync(target); return { ok: true, path: target }; }
  catch (e) { return { ok: false, error: e.code === 'EEXIST' ? 'A folder with this name already exists.' : e.message }; }
});

ipcMain.handle('shell:open', async (_e, url) => { await shell.openExternal(url); return { ok: true }; });

// ================= app =================
app.whenReady().then(async () => {
  // Self-check: Electron needs system libraries that a bare Linux install may
  // not have. Check first; offer a one-click install; never crash cryptically.
  try {
    const d = await deps.checkDeps();
    if (d.missing.length) {
      const detail = `Missing system libraries (${d.missing.length}): ${d.missing.slice(0, 6).join(', ')}${d.missing.length > 6 ? '…' : ''}\n\n` +
        (d.command ? `Install with:\n${d.command}` : 'Your package manager was not detected — install the matching GTK/NSS/ALSA libraries for your distro.');
      const { response } = await dialog.showMessageBox(null, {
        type: 'warning', title: 'Rogue — missing system libraries',
        message: 'Some system libraries this app needs are not installed on this machine.',
        detail,
        buttons: ['Install now (asks for your password)', 'Continue anyway', 'Quit'],
        defaultId: 0, cancelId: 2, noLink: true,
      });
      if (response === 2) { app.quit(); return; }
      if (response === 0 && d.command) {
        const shellCmd = d.command.replace(/sudo /g, '');
        const ok = await new Promise((resolve) => {
          const c = spawn('pkexec', ['sh', '-c', shellCmd], { stdio: 'ignore' });
          c.once('error', () => resolve(false));
          c.once('exit', (code) => resolve(code === 0));
        });
        if (ok) {
          const d2 = await deps.checkDeps();
          if (!d2.missing.length) { app.relaunch(); app.quit(); return; }
        }
        await dialog.showMessageBox(null, {
          type: 'error', title: 'Rogue — install did not complete',
          message: 'The automatic install did not finish. Run this in a terminal, then start the app again:',
          detail: d.command, buttons: ['OK'], noLink: true,
        });
      }
    }
  } catch (e) { console.error('dependency check failed:', e.message); }
  createWindow(); setupTray(); registerHotkey();
});
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
app.on('window-all-closed', () => { stopOpencodeServer(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { app.quitting = true; stopOpencodeServer(); terms.forEach(p => { try { p.kill(); } catch {} }); });
