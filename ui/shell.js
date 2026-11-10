// Rogue — shell UI logic
const $ = id => document.getElementById(id);
const tabs = document.querySelectorAll('.tab');
let ocFolder = null;
let ocBooted = false;
let connectedProviders = [];
let appSettings = { recentFolders: [], autoBoot: false, minimizeToTray: true, lastFolder: null,
  globalHotkey: true, savedSnippets: [], dailyBudget: null, backupEnabled: false, backupDir: null, lastBackup: 0,
  theme: 'dark' };

function setStatus(el, msg, cls = '') { el.textContent = msg; el.className = 'status ' + cls; }
function setPill(text, live) { $('engine-text').textContent = text; $('engine-pill').classList.toggle('live', !!live); }
function toast(msg, ok = true) {
  const box = $('toasts'); if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast' + (ok ? ' ok' : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 2600);
}
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active', 'flex'));
  const v = $(id); if (!v) return;
  v.classList.add('active', 'flex');
  const tabFor = id === 'view-setup' ? 'view-home' : id;
  tabs.forEach(t => t.classList.toggle('active', t.dataset.view === tabFor));
  if (id === 'view-terminal') ensureTerminal();
  if (id === 'view-arsenal') refreshArsenal();
}
tabs.forEach(t => t.addEventListener('click', () => {
  const id = t.dataset.view;
  showView(id);
}));
document.addEventListener('keydown', e => {
  if (!e.ctrlKey || e.shiftKey || e.altKey) return;
  const map = { 1: 'view-home', 2: 'view-opencode', 3: 'view-terminal', 4: 'view-arsenal' };
  if (map[e.key]) { e.preventDefault(); showView(map[e.key]); }
  if (e.key === 'F4') {
    e.preventDefault();
    // terminal open with a tab -> close that tab; anywhere else -> close the
    // window (same as the X button: tray if enabled, else quit)
    if (document.querySelector('#view-terminal.active') && activeTermTab()) closeTermTab(activeTerm);
    else window.rogue.windowClose();
  }
});

// ---------- settings ----------
async function loadSettings() {
  try { const r = await window.rogue.settingsGet(); if (r.ok) appSettings = Object.assign(appSettings, r.settings); } catch {}
  applyTheme();
  $('set-autoboot').checked = !!appSettings.autoBoot;
  $('set-tray').checked = !!appSettings.minimizeToTray;
  $('set-hotkey').checked = appSettings.globalHotkey !== false;
  // stable working folder: last used, no nagging every launch
  ocFolder = appSettings.lastFolder || (appSettings.recentFolders[0] || null);
  $('oc-folder').textContent = ocFolder || '~';
  renderRecent();
  renderSnippets();
  updateBackupUI();
}
async function saveSettings() { try { await window.rogue.settingsSet(appSettings); } catch {} }
$('set-autoboot').addEventListener('change', e => { appSettings.autoBoot = e.target.checked; saveSettings(); });
$('set-tray').addEventListener('change', e => { appSettings.minimizeToTray = e.target.checked; saveSettings(); });
$('set-hotkey').addEventListener('change', e => { appSettings.globalHotkey = e.target.checked; saveSettings(); toast(e.target.checked ? 'global hotkey enabled (Ctrl+Alt+A)' : 'global hotkey disabled'); });
function renderRecent() {
  const row = $('recent-row'), chips = $('recent-chips');
  const list = (appSettings.recentFolders || []).filter(Boolean);
  if (!list.length) { row.style.display = 'none'; return; }
  row.style.display = 'flex'; chips.innerHTML = '';
  list.forEach(d => {
    const c = document.createElement('button');
    c.className = 'chip'; c.textContent = d; c.title = d;
    c.onclick = () => { ocFolder = d; $('oc-folder').textContent = d; bootEngine(); };
    chips.appendChild(c);
  });
}
// Join the Outcastors WhatsApp community (fixed invite link)
const WA_GROUP_URL = 'https://chat.whatsapp.com/ID10GJWOctCKCy5KYn2ZXN?s=cl&p=a&iam=2';
$('btn-wa-join').addEventListener('click', () => window.rogue.openExternal(WA_GROUP_URL));
// Outcastors on LinkedIn (verified company page) and GitHub (his account)
const LI_PAGE_URL = 'https://www.linkedin.com/company/outcastors';
const GH_URL = 'https://github.com/Outcastors';
$('btn-li-outcastors').addEventListener('click', () => window.rogue.openExternal(LI_PAGE_URL));
$('btn-gh-outcastors').addEventListener('click', () => window.rogue.openExternal(GH_URL));

// Themed confirm dialog (replaces the native white confirm box)
let _confirmResolve = null;
function confirmDialog(title, message, okLabel) {
  return new Promise((resolve) => {
    _confirmResolve = resolve;
    $('confirm-title').textContent = title;
    $('confirm-msg').textContent = message;
    $('confirm-ok').textContent = okLabel || 'Delete';
    $('confirm-overlay').style.display = 'flex';
  });
}
function _closeConfirm(v) {
  $('confirm-overlay').style.display = 'none';
  if (_confirmResolve) { const r = _confirmResolve; _confirmResolve = null; r(v); }
}
$('confirm-ok').addEventListener('click', () => _closeConfirm(true));
$('confirm-cancel').addEventListener('click', () => _closeConfirm(false));
$('confirm-overlay').addEventListener('click', (e) => { if (e.target === $('confirm-overlay')) _closeConfirm(false); });

// Themed name prompt (same look as the confirm dialog) — returns the typed text or null
let _promptResolve = null;
function promptDialog(title, message, placeholder) {
  return new Promise((resolve) => {
    _promptResolve = resolve;
    $('prompt-title').textContent = title;
    $('prompt-msg').textContent = message;
    const inp = $('prompt-input');
    inp.value = ''; inp.placeholder = placeholder || '';
    $('prompt-overlay').style.display = 'flex';
    setTimeout(() => inp.focus(), 50);
  });
}
function _closePrompt(v) {
  $('prompt-overlay').style.display = 'none';
  if (_promptResolve) { const r = _promptResolve; _promptResolve = null; r(v ? $('prompt-input').value.trim() : null); }
}
$('prompt-ok').addEventListener('click', () => _closePrompt(true));
$('prompt-cancel').addEventListener('click', () => _closePrompt(false));
$('prompt-overlay').addEventListener('click', (e) => { if (e.target === $('prompt-overlay')) _closePrompt(false); });
$('prompt-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') _closePrompt(true); if (e.key === 'Escape') _closePrompt(false); });

// New folder in the working directory
async function askNewFolder() {
  const where = ocFolder || '~';
  const name = await promptDialog('New folder', 'Create a folder inside ' + where + ':', 'folder-name');
  if (!name) return;
  const r = await window.rogue.folderCreate(name, ocFolder);
  if (r.ok) toast('✓ folder created: ' + r.path);
  else toast('✖ ' + r.error, false);
}
$('btn-oc-newfolder').addEventListener('click', askNewFolder);
$('oc-newfolder').addEventListener('click', askNewFolder);

$('btn-desktop').addEventListener('click', async e => {
  const b = e.target; b.disabled = true;
  const r = await window.rogue.desktopInstall();
  b.textContent = r.ok ? '✓ launcher installed' : '✖ ' + (r.error || 'failed');
  if (r.ok) toast('launcher icon installed ✓');
  setTimeout(() => { b.textContent = 'install launcher icon'; b.disabled = false; }, 2500);
});

// ---------- OpenCode ----------
$('oc-pick').addEventListener('click', async () => {
  const dir = await window.rogue.pickFolder();
  if (dir) {
    ocFolder = dir; $('oc-folder').textContent = dir;
    appSettings.lastFolder = dir; saveSettings();
  }
});
async function bootEngine() {
  const btn = $('btn-opencode');
  btn.disabled = true;
  setStatus($('oc-status'), '⏳ starting opencode engine…', 'busy');
  setPill('starting opencode…', false);
  const r = await window.rogue.opencodeEnsure(ocFolder);
  btn.disabled = false;
  if (!r.ok) {
    $('oc-progress').classList.remove('show');
    setStatus($('oc-status'), '✖ ' + r.error, 'err');
    setPill('idle', false);
    return;
  }
  ocBooted = true;
  $('oc-frame').src = r.url;
  const cwd = ocFolder || '~';
  $('oc-bar-folder').textContent = 'cwd: ' + cwd;
  setStatus($('oc-status'), '● engine live', 'ok');
  setPill('opencode live', true);
  // recent folders
  try {
    const s = await window.rogue.settingsGet();
    appSettings = Object.assign(appSettings, s.settings || {});
    const dir = ocFolder;
    if (dir) appSettings.recentFolders = [dir, ...appSettings.recentFolders.filter(d => d !== dir)].slice(0, 6);
    appSettings.lastFolder = dir || appSettings.lastFolder;
    await window.rogue.settingsSet(appSettings);
    renderRecent();
  } catch {}
  await refreshProviders(); await refreshQuickModel(); // engine is live now — the dropdown can see the server's real provider list
  showView('view-opencode');
}
$('btn-opencode').addEventListener('click', bootEngine);
window.rogue.onTrayOpenOpencode(() => { if (!ocBooted) bootEngine(); else showView('view-opencode'); });
window.rogue.onEngineProgress(p => {
  const bar = $('oc-progress'), fill = $('oc-progress-bar');
  if (p.stage === 'download') { bar.classList.add('show'); fill.style.width = p.pct + '%'; setStatus($('oc-status'), '⏳ ' + p.text, 'busy'); }
  else if (p.stage === 'live') { fill.style.width = '100%'; setTimeout(() => bar.classList.remove('show'), 1500); setStatus($('oc-status'), '● ' + p.text, 'ok'); }
  else setStatus($('oc-status'), '⏳ ' + p.text, 'busy');
});
$('btn-oc-restart').addEventListener('click', async () => {
  $('oc-frame').src = 'about:blank';
  await window.rogue.opencodeStop();
  ocBooted = false; setPill('idle', false);
  showView('view-home');
  setStatus($('oc-status'), 'engine stopped — press Enter to boot again', '');
});
$('btn-oc-home').addEventListener('click', () => showView('view-home'));

// ---------- Terminal (multi-tab) ----------
let termTabs = []; // {ptyId, term, fit, pane, label}
let activeTerm = -1;
function fitAddonCtor() {
  if (window.FitAddon) return window.FitAddon.FitAddon || window.FitAddon;
  return null;
}
function renderTermTabs() {
  const bar = $('term-tabs'), addBtn = $('btn-term-newtab');
  bar.querySelectorAll('.term-tab').forEach(t => t.remove());
  termTabs.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'term-tab' + (i === activeTerm ? ' active' : '');
    const lbl = document.createElement('span'); lbl.textContent = t.label;
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = 'Close terminal';
    x.onclick = (e) => { e.stopPropagation(); closeTermTab(i); };
    b.appendChild(lbl); b.appendChild(x);
    b.onclick = () => switchTermTab(i);
    bar.insertBefore(b, addBtn);
  });
}
async function newTermTab(cwd) {
  let av = { available: false };
  try { av = await window.rogue.termAvailable(); } catch {}
  if (!av.available) { $('term-wrap').innerHTML = '<div class="log">terminal engine unavailable in this build.</div>'; return; }
  const r = await window.rogue.termSpawn(cwd || ocFolder);
  if (!r.ok) { toast('terminal failed: ' + r.error, false); return; }
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  $('term-wrap').appendChild(pane);
  const term = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: '#050508', foreground: '#e8e8f0' } });
  const FA = fitAddonCtor();
  let fit = null;
  if (FA) { fit = new FA(); term.loadAddon(fit); }
  term.open(pane);
  const tab = { ptyId: r.id, term, fit, pane, label: 'Terminal ' + (termTabs.length + 1) };
  term.onData(d => window.rogue.termWrite(tab.ptyId, d));
  termTabs.push(tab);
  term.writeln('\x1b[1;31m☠ rogue terminal\x1b[0m — type \x1b[1mopencode\x1b[0m for the TUI, or run any command.');
  switchTermTab(termTabs.length - 1);
  renderTermTabs();
  $('term-cwd').textContent = 'cwd: ' + (cwd || ocFolder || '~');
}
function switchTermTab(i) {
  if (!termTabs[i]) return;
  activeTerm = i;
  termTabs.forEach((t, j) => t.pane.classList.toggle('active', j === i));
  renderTermTabs();
  requestAnimationFrame(() => {
    const t = termTabs[i];
    try { t.fit && t.fit.fit(); window.rogue.termResize(t.ptyId, t.term.cols, t.term.rows); t.term.focus(); } catch {}
  });
}
async function closeTermTab(i) {
  const t = termTabs[i]; if (!t) return;
  try { await window.rogue.termKill(t.ptyId); } catch {}
  try { t.term.dispose(); } catch {}
  t.pane.remove();
  termTabs.splice(i, 1);
  termTabs.forEach((x, j) => x.label = 'Terminal ' + (j + 1));
  activeTerm = -1;
  if (termTabs.length) switchTermTab(Math.min(i, termTabs.length - 1));
  else renderTermTabs();
}
async function ensureTerminal() {
  if (!termTabs.length) await newTermTab();
  else if (activeTerm >= 0) switchTermTab(activeTerm);
}
function activeTermTab() { return termTabs[activeTerm] || null; }
window.rogue.onTermData(({ id, data }) => {
  const t = termTabs.find(t => t.ptyId === id);
  if (t) t.term.write(data);
});
window.rogue.onTermExit(({ id }) => {
  const t = termTabs.find(t => t.ptyId === id);
  if (t) t.term.writeln('\r\n\x1b[33m[terminal closed]\x1b[0m');
});
$('btn-term-newtab').addEventListener('click', () => newTermTab());
$('btn-term-reconnect').addEventListener('click', async () => {
  const t = activeTermTab();
  if (!t) { newTermTab(); return; }
  try { await window.rogue.termKill(t.ptyId); } catch {}
  const r = await window.rogue.termSpawn(ocFolder);
  if (!r.ok) { toast('reconnect failed: ' + r.error, false); return; }
  t.ptyId = r.id;
  t.term.writeln('\r\n\x1b[33m[reconnected]\x1b[0m');
});
$('btn-term-opencode').addEventListener('click', async () => {
  if (!termTabs.length) await newTermTab();
  const t = activeTermTab();
  if (t) { window.rogue.termWrite(t.ptyId, 'opencode\n'); showView('view-terminal'); }
});
window.addEventListener('resize', () => {
  const t = activeTermTab();
  try { t && t.fit && t.fit.fit(); t && window.rogue.termResize(t.ptyId, t.term.cols, t.term.rows); } catch {}
});

// ---------- Saved snippets ----------
function renderSnippets() {
  const box = $('snp-chips'); box.innerHTML = '';
  (appSettings.savedSnippets || []).forEach((s, i) => {
    const c = document.createElement('button');
    c.className = 'snp-chip'; c.title = s.cmd;
    const lbl = document.createElement('span'); lbl.textContent = '▶ ' + s.name;
    const x = document.createElement('span'); x.textContent = ' ×'; x.style.color = 'var(--faint)'; x.title = 'Delete snippet';
    x.onclick = (e) => { e.stopPropagation(); appSettings.savedSnippets.splice(i, 1); saveSettings(); renderSnippets(); };
    c.appendChild(lbl); c.appendChild(x);
    c.onclick = async () => {
      if (!termTabs.length) await newTermTab();
      const t = activeTermTab();
      if (t) { window.rogue.termWrite(t.ptyId, s.cmd + '\n'); showView('view-terminal'); }
    };
    box.appendChild(c);
  });
}
$('snp-add').addEventListener('click', () => {
  const name = $('snp-name').value.trim(), cmd = $('snp-cmd').value.trim();
  if (!name || !cmd) { toast('name and command required', false); return; }
  appSettings.savedSnippets = [...(appSettings.savedSnippets || []), { name, cmd }];
  saveSettings(); renderSnippets();
  $('snp-name').value = ''; $('snp-cmd').value = '';
  toast('snippet saved ✓');
});

// ---------- Setup wizard ----------
const PROVIDERS = [
  { id: 'groq', name: 'Groq', hint: 'free tier · console.groq.com/keys' },
  { id: 'openai', name: 'OpenAI', hint: 'platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic', hint: 'console.anthropic.com' },
  { id: 'google', name: 'Google Gemini', hint: 'aistudio.google.com/apikey' },
  { id: 'deepseek', name: 'DeepSeek', hint: 'platform.deepseek.com/api_keys' },
  { id: 'mistral', name: 'Mistral', hint: 'console.mistral.ai/api-keys' },
  { id: 'openrouter', name: 'OpenRouter', hint: 'openrouter.ai/keys · free models too' },
  { id: 'ollama', name: 'Ollama (local)', hint: 'runs on your machine — no key needed · ollama.com', local: true },
  { id: 'ollama-cloud', name: 'Ollama Cloud', hint: 'free tier · ollama.com/settings/keys' },
  { id: 'zai', name: 'Zhipu (GLM)', hint: 'free tier · open.bigmodel.cn' },
  { id: 'chutes', name: 'Chutes', hint: 'free tier · chutes.ai' },
  { id: 'nebius', name: 'Nebius', hint: 'free credits · nebius.com' },
  { id: 'deepinfra', name: 'DeepInfra', hint: 'free tier · deepinfra.com' },
  { id: 'xai', name: 'xAI (Grok)', hint: 'console.x.ai' },
  { id: 'cohere', name: 'Cohere', hint: 'dashboard.cohere.com/api-keys' },
  { id: 'togetherai', name: 'Together AI', hint: 'api.together.ai/settings/api-keys' },
  { id: 'cerebras', name: 'Cerebras', hint: 'cloud.cerebras.ai' },
  { id: 'moonshotai', name: 'Moonshot (Kimi)', hint: 'platform.moonshot.ai' },
  { id: 'alibaba', name: 'Alibaba (Qwen)', hint: 'DashScope · bailian.console.aliyun.com' },
];
let selectedProvider = null;
async function refreshProviders() {
  try { const r = await window.rogue.authList(); connectedProviders = r.ok ? r.providers : []; }
  catch { connectedProviders = []; }
  $('oc-providers').textContent = connectedProviders.length ? connectedProviders.join(', ') + ' ✓' : 'none connected';
  renderProvGrid();
}
function renderProvGrid() {
  const g = $('prov-grid'); g.innerHTML = '';
  PROVIDERS.forEach(p => {
    const d = document.createElement('div');
    d.className = 'prov-card' + (connectedProviders.includes(p.id) ? ' connected' : '') + (selectedProvider === p.id ? ' selected' : '');
    d.innerHTML = `<div class="tick">✓</div><div class="pname">${p.name}</div><div class="phint">${p.hint}</div>`;
    d.onclick = () => selectProvider(p.id);
    g.appendChild(d);
  });
}
function selectProvider(id) {
  selectedProvider = id;
  const p = PROVIDERS.find(x => x.id === id);
  renderProvGrid();
  if (p.local) { // Ollama runs on your machine — no API key, connect instead
    $('key-panel').style.display = 'none';
    $('ollama-panel').style.display = 'block';
    $('ollama-prov-name').innerHTML = `${p.name} ${connectedProviders.includes(id) ? '<span style="color:var(--green);font-size:12px">· connected ✓</span>' : ''}`;
    checkOllamaSetup();
    return;
  }
  $('ollama-panel').style.display = 'none';
  $('key-panel').style.display = 'block';
  $('key-prov-name').innerHTML = `${p.name} ${connectedProviders.includes(id) ? '<span style="color:var(--green);font-size:12px">· connected ✓</span>' : ''}`;
  $('key-hint').textContent = 'Get your key at: ' + p.hint;
  $('key-input').value = ''; setStatus($('key-status'), '', '');
  $('key-input').focus();
}
async function checkOllamaSetup() {
  const r = await window.rogue.ollamaStatus();
  setStatus($('ollama-status'),
    r.running
      ? '● Ollama is running — ' + r.models.length + ' model(s) installed: ' + r.models.join(', ')
      : '○ Ollama is not running on this machine. Install it from ollama.com, then run: ollama pull llama3.1',
    r.running ? 'ok' : '');
  $('ollama-connect-setup').disabled = !r.running || !r.models.length;
}
$('ollama-cancel').addEventListener('click', () => { $('ollama-panel').style.display = 'none'; selectedProvider = null; renderProvGrid(); });
$('ollama-connect-setup').addEventListener('click', async () => {
  const btn = $('ollama-connect-setup'); btn.disabled = true;
  setStatus($('ollama-status'), '⏳ connecting…', 'busy');
  const r = await window.rogue.ollamaConnect();
  btn.disabled = false;
  if (r.ok) {
    setStatus($('ollama-status'), '✓ Connected: ' + r.models.join(', ') + ' — restart the engine to use them.', 'ok');
    toast('Ollama connected ✓');
    await refreshProviders(); await refreshQuickModel();
  } else setStatus($('ollama-status'), '✖ ' + r.error, 'err');
});
$('key-cancel').addEventListener('click', () => { $('key-panel').style.display = 'none'; selectedProvider = null; renderProvGrid(); });
$('key-save').addEventListener('click', async () => {
  const key = $('key-input').value.trim();
  if (!selectedProvider || !key) return;
  const btn = $('key-save'); btn.disabled = true;
  setStatus($('key-status'), '⏳ saving…', 'busy');
  const r = await window.rogue.authSave(selectedProvider, key);
  btn.disabled = false;
  if (r.ok) {
    connectedProviders = r.providers; renderProvGrid(); selectProvider(selectedProvider);
    setStatus($('key-status'), '✓ Saved. Select a model in OpenCode with /models.', 'ok');
    toast('API key saved ✓');
    $('oc-providers').textContent = connectedProviders.join(', ') + ' ✓';
    $('key-input').value = '';
    await refreshQuickModel(); // dropdown must show the new key at once, no restart
  } else setStatus($('key-status'), '✖ ' + r.error, 'err');
});
$('key-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('key-save').click(); });
$('oc-setup-keys').addEventListener('click', () => { refreshProviders(); showView('view-setup'); });
$('setup-back').addEventListener('click', () => showView('view-home'));

// ---------- ARSENAL ----------
async function refreshArsenal() {
  arsProviders(); defModelInit(); loadStats(); loadEngine(); loadMcp(); loadPlugins(); loadOllama(); loadHunter(); loadAgents(); renderPrompts(); loadSessions();
  if (appSettings.dailyBudget) $('budget-input').value = appSettings.dailyBudget;
}
function kvRow(k, v, cls) { return `<div class="kv"><span>${k}</span><b class="${cls || ''}">${v}</b></div>`; }

// providers mgmt
async function arsProviders() {
  const r = await window.rogue.authList();
  const list = r.ok ? r.providers : [];
  const box = $('ars-providers');
  if (!list.length) { box.innerHTML = '<div class="kv"><span>none connected</span><b class="warn">—</b></div>'; return; }
  box.innerHTML = '';
  list.forEach(p => {
    const d = document.createElement('div'); d.className = 'kv';
    d.innerHTML = `<span>${p}</span>`;
    const b = document.createElement('button');
    b.className = 'btn ghost small'; b.textContent = 'remove'; b.style.padding = '4px 10px';
    b.onclick = async () => {
      if (!(await confirmDialog('Remove key?', `Remove the ${p} API key? You can add it again any time from the setup wizard.`, 'Remove'))) return;
      const rr = await window.rogue.authRemove(p);
      if (rr.ok) { connectedProviders = rr.providers; arsProviders(); refreshProviders(); await refreshQuickModel(); }
    };
    const right = document.createElement('span'); right.style.display = 'flex'; right.style.gap = '8px'; right.style.alignItems = 'center';
    const ok = document.createElement('b'); ok.className = 'ok'; ok.textContent = '✓';
    right.appendChild(ok); right.appendChild(b); d.appendChild(right);
    box.appendChild(d);
  });
}
$('ars-keys').addEventListener('click', () => { refreshProviders(); showView('view-setup'); });

// default model
async function defModelInit() {
  const cfg = (await window.rogue.configGet()).config || {};
  const cur = cfg.model || null;
  setStatus($('dm-status'), cur ? 'current default: ' + cur : 'no default set — opencode picks its own', cur ? 'ok' : '');
  const ps = $('dm-provider');
  ps.innerHTML = connectedProviders.length
    ? connectedProviders.map(p => `<option value="${p}">${p}</option>`).join('')
    : '<option value="">— connect a key first —</option>';
  await defModelLoad();
}
$('dm-provider').addEventListener('change', defModelLoad);
async function defModelLoad() {
  const p = $('dm-provider').value, ms = $('dm-model');
  if (!p) { ms.innerHTML = ''; return; }
  ms.innerHTML = '<option>loading…</option>';
  const r = await window.rogue.engineModels(p);
  ms.innerHTML = r.ok
    ? r.models.map(m => `<option value="${m}">${m}</option>`).join('')
    : '<option value="">' + (r.error || 'failed') + '</option>';
}
$('dm-save').addEventListener('click', async () => {
  const m = $('dm-model').value;
  if (!m) return;
  const r = await window.rogue.configSetModel(m);
  setStatus($('dm-status'), r.ok ? '✓ default saved: ' + m + ' (restart engine to apply)' : '✖ ' + r.error, r.ok ? 'ok' : 'err');
    if (r.ok) toast('default model saved ✓');
});
$('dm-clear').addEventListener('click', async () => {
  await window.rogue.configSetModel(null);
  setStatus($('dm-status'), 'default cleared', 'ok');
});

// usage
$('stats-refresh').addEventListener('click', loadStats);
$('stats-days').addEventListener('change', loadStats);
async function loadStats() {
  const box = $('stats-box');
  box.innerHTML = '<div class="kv"><span>loading…</span><b>—</b></div>';
  const r = await window.rogue.engineStats(parseInt($('stats-days').value, 10));
  if (!r.ok) { box.innerHTML = `<div class="kv"><span>error</span><b class="warn">${r.error}</b></div>`; return; }
  const s = r.stats, v = x => x || '0';
  box.innerHTML =
    kvRow('sessions', v(s.sessions)) + kvRow('messages', v(s.messages)) +
    kvRow('total cost', v(s.cost), 'ok') + kvRow('input tokens', v(s.input)) +
    kvRow('output tokens', v(s.output)) + kvRow('cache read', v(s.cacheRead));
  checkBudget();
}

// daily cost alert
$('budget-save').addEventListener('click', () => {
  const val = parseFloat($('budget-input').value);
  if (!(val > 0)) { setStatus($('budget-status'), 'Enter a valid amount, e.g. 2.00', 'err'); return; }
  appSettings.dailyBudget = Math.round(val * 100) / 100;
  saveSettings();
  setStatus($('budget-status'), `daily budget set: $${appSettings.dailyBudget.toFixed(2)}`, 'ok');
  toast('budget alert set ✓');
  checkBudget();
});
async function checkBudget() {
  const b = appSettings.dailyBudget;
  if (!(b > 0)) { setStatus($('budget-status'), '', ''); return; }
  try {
    const t = await window.rogue.engineStats(1);
    const cost = t.ok ? (parseFloat(String(t.stats.cost || '').replace(/[^0-9.]/g, '')) || 0) : 0;
    if (cost > b) {
      setStatus($('budget-status'), `⚠ budget exceeded — today $${cost.toFixed(2)} / $${b.toFixed(2)}`, 'err');
      toast(`daily budget exceeded ($${cost.toFixed(2)})`, false);
    } else {
      setStatus($('budget-status'), `today $${cost.toFixed(2)} of $${b.toFixed(2)} budget`, 'ok');
    }
  } catch {}
}

// engine
async function loadEngine() {
  const r = await window.rogue.engineVersion();
  $('eng-ver').textContent = r.version ? 'v' + r.version : 'not installed';
}
$('eng-upgrade').addEventListener('click', async e => {
  const b = e.target; b.disabled = true;
  const log = $('eng-log'); log.style.display = 'block'; log.textContent = '';
  window.rogue.onUpgradeLog(t => { log.textContent += t; log.scrollTop = log.scrollHeight; });
  const r = await window.rogue.engineUpgrade();
  b.disabled = false;
  if (r.ok) loadEngine();
});

// mcp
async function loadMcp() {
  const cfg = (await window.rogue.configGet()).config || {};
  const mcp = cfg.mcp || {};
  const box = $('mcp-list');
  const names = Object.keys(mcp);
  if (!names.length) { box.innerHTML = '<div class="kv"><span>no mcp servers</span><b>—</b></div>'; return; }
  box.innerHTML = '';
  names.forEach(n => {
    const s = mcp[n] || {};
    const d = document.createElement('div'); d.className = 'kv';
    const label = document.createElement('span'); label.textContent = `${n} · ${s.type || 'local'}`;
    const right = document.createElement('span'); right.style.display = 'flex'; right.style.gap = '8px'; right.style.alignItems = 'center';
    const tg = document.createElement('button');
    tg.className = 'btn ghost small'; tg.style.padding = '4px 10px';
    tg.textContent = s.enabled === false ? 'enable' : 'disable';
    tg.onclick = async () => { const r = await window.rogue.mcpToggle(n, s.enabled === false); if (r.ok) loadMcp(); };
    const rm = document.createElement('button');
    rm.className = 'btn ghost small'; rm.style.padding = '4px 10px'; rm.textContent = '✕';
    rm.onclick = async () => { if (!(await confirmDialog('Remove MCP server?', `Remove the "${n}" MCP server from the config?`, 'Remove'))) return; const r = await window.rogue.mcpRemove(n); if (r.ok) loadMcp(); };
    right.appendChild(tg); right.appendChild(rm);
    d.appendChild(label); d.appendChild(right);
    box.appendChild(d);
  });
}
$('mcp-type').addEventListener('change', e => {
  const remote = e.target.value === 'remote';
  $('mcp-url').style.display = remote ? '' : 'none';
  $('mcp-cmd').style.display = remote ? 'none' : '';
});
$('mcp-add').addEventListener('click', async () => {
  const spec = {
    name: $('mcp-name').value, type: $('mcp-type').value,
    command: $('mcp-cmd').value, url: $('mcp-url').value, env: $('mcp-env').value,
  };
  const r = await window.rogue.mcpAdd(spec);
  if (r.ok) {
    setStatus($('mcp-status'), '✓ added — restart engine to load it', 'ok');
    toast('MCP server added ✓');
    $('mcp-name').value = ''; $('mcp-cmd').value = ''; $('mcp-url').value = ''; $('mcp-env').value = '';
    loadMcp();
  } else setStatus($('mcp-status'), '✖ ' + r.error, 'err');
});

// plugins
async function loadPlugins() {
  const cfg = (await window.rogue.configGet()).config || {};
  const plugs = cfg.plugin || [];
  $('plug-list').innerHTML = plugs.length
    ? plugs.map(p => kvRow(typeof p === 'string' ? p : JSON.stringify(p), 'installed', 'ok')).join('')
    : '<div class="kv"><span>no plugins</span><b>—</b></div>';
}
$('plug-install').addEventListener('click', async e => {
  const name = $('plug-name').value.trim();
  if (!name) return;
  const b = e.target; b.disabled = true;
  const log = $('plug-log'); log.style.display = 'block'; log.textContent = '';
  window.rogue.onPluginLog(t => { log.textContent += t; log.scrollTop = log.scrollHeight; });
  const r = await window.rogue.pluginInstall(name);
  b.disabled = false;
  if (r.ok) { $('plug-name').value = ''; loadPlugins(); }
    if (r.ok) { $('plug-name').value = ''; loadPlugins(); toast('plugin installed ✓'); }
});

// ollama
async function loadOllama() {
  const r = await window.rogue.ollamaStatus();
  $('ollama-status').innerHTML = r.running
    ? `<span class="ok">${r.models.length} models found</span>`
    : '<span class="warn">not running</span>';
  $('ollama-status').dataset.models = JSON.stringify(r.models || []);
}
$('ollama-refresh').addEventListener('click', loadOllama);
$('ollama-connect').addEventListener('click', async () => {
  const r = await window.rogue.ollamaConnect();
  setStatus($('ollama-msg'), r.ok ? '✓ connected: ' + r.models.join(', ') : '✖ ' + r.error, r.ok ? 'ok' : 'err');
    if (r.ok) toast('Ollama connected ✓');
  if (r.ok) { loadOllama(); await refreshProviders(); await refreshQuickModel(); }
});

// hunter
async function loadHunter() {
  const r = await window.rogue.hunterStatus();
  $('hunter-status').innerHTML = r.installed ? '<span class="ok">installed ✓</span>' : '<span class="warn">not installed</span>';
  $('hunter-toggle').textContent = r.installed ? 'remove' : 'install hunter';
  $('hunter-toggle').onclick = async () => {
    const rr = r.installed ? await window.rogue.hunterRemove() : await window.rogue.hunterInstall();
    if (rr.ok) loadHunter();
    if (rr.ok) { loadHunter(); toast(r.installed ? 'hunter removed' : 'hunter installed ✓'); }
  };
}

// backup
$('btn-backup').addEventListener('click', async () => {
  setStatus($('backup-status'), '⏳ backing up…', 'busy');
  const r = await window.rogue.sessionsBackup();
  setStatus($('backup-status'), r.ok ? '✓ saved to ' + r.path : (r.error === 'cancelled' ? '' : '✖ ' + r.error), r.ok ? 'ok' : 'err');
    if (r.ok) toast('backup saved ✓');
});

// conversation history — persists until YOU delete (with search + export)
let allSessions = [];
$('sess-refresh').addEventListener('click', loadSessions);
$('sess-search').addEventListener('input', () => renderSessions());
async function loadSessions() {
  const box = $('sess-list');
  box.innerHTML = '<div class="kv"><span>loading…</span><b>—</b></div>';
  const r = await window.rogue.sessionsList();
  if (!r.ok) { box.innerHTML = `<div class="kv"><span>error</span><b class="warn">${r.error}</b></div>`; allSessions = []; return; }
  allSessions = r.sessions || [];
  renderSessions();
}
function renderSessions() {
  const box = $('sess-list');
  const q = ($('sess-search').value || '').toLowerCase();
  const list = allSessions.filter(s => !q || (s.title + ' ' + (s.directory || '')).toLowerCase().includes(q));
  if (!list.length) { box.innerHTML = `<div class="kv"><span>${allSessions.length ? 'no matches' : 'no sessions yet'}</span><b>—</b></div>`; return; }
  box.innerHTML = '';
  list.forEach(s => {
    const d = document.createElement('div'); d.className = 'kv';
    const label = document.createElement('span');
    label.style.maxWidth = '46%'; label.style.overflow = 'hidden'; label.style.textOverflow = 'ellipsis'; label.style.whiteSpace = 'nowrap';
    const when = s.created ? new Date(s.created).toLocaleString() : (s.updated || '');
    label.textContent = `${s.title}${s.directory ? ' · ' + s.directory : ''}${when ? ' · ' + when : ''}`;
    label.title = `${s.id}\n${s.title}\n${s.directory || ''}`;
    const right = document.createElement('span'); right.style.display = 'flex'; right.style.gap = '8px'; right.style.alignItems = 'center';
    const open = document.createElement('button');
    open.className = 'btn ghost small'; open.style.padding = '4px 10px'; open.textContent = 'open';
    open.title = "Boot the engine in this session's folder";
    open.onclick = async () => {
      if (s.directory) {
        await window.rogue.opencodeStop();
        ocBooted = false;
        ocFolder = s.directory; $('oc-folder').textContent = ocFolder;
        appSettings.lastFolder = ocFolder; saveSettings();
        setStatus($('sess-status'), '⏳ Opening in ' + ocFolder + ' …', 'busy');
        await bootEngine();
        setStatus($('sess-status'), '✓ opened', 'ok');
      } else { showView('view-opencode'); }
    };
    const exp = document.createElement('button');
    exp.className = 'btn ghost small'; exp.style.padding = '4px 10px'; exp.textContent = '\u2913';
    exp.title = 'Export as markdown';
    exp.onclick = async () => {
      setStatus($('sess-status'), '⏳ exporting…', 'busy');
      const rr = await window.rogue.sessionsExport(s.id);
      if (rr.ok) { setStatus($('sess-status'), '✓ exported to ' + rr.path, 'ok'); toast('session exported ✓'); }
      else setStatus($('sess-status'), rr.error === 'cancelled' ? '' : '✖ ' + rr.error, 'err');
    };
    const del = document.createElement('button');
    del.className = 'btn ghost small'; del.style.padding = '4px 10px'; del.textContent = '✕';
    del.title = 'Delete this session permanently';
    del.onclick = async () => {
      if (!(await confirmDialog('Delete session?', `Delete session "${s.title}"? This cannot be undone.`))) return;
      const rr = await window.rogue.sessionsDelete(s.id);
      if (rr.ok) { setStatus($('sess-status'), '✓ deleted', 'ok'); toast('session deleted'); loadSessions(); }
      else setStatus($('sess-status'), '✖ ' + rr.error, 'err');
    };
    right.appendChild(open); right.appendChild(exp); right.appendChild(del);
    d.appendChild(label); d.appendChild(right);
    box.appendChild(d);
  });
}

// prompt library
const PROMPTS = [
  { t: 'Vulnerability Audit', p: 'Perform a white-hat security audit of this project (I am authorized to test it). Map findings to OWASP Top 10 / CWE IDs, rate severity Critical/High/Medium/Low, cite the vulnerable lines, briefly explain the exploit scenario, and give a concrete fix for each. Findings table first, details after.' },
  { t: 'Explain This Code', p: 'Explain what this code does step by step. Focus on security-relevant behavior: input handling, authentication, cryptography, network calls, and trust boundaries.' },
  { t: 'Nuclei Template', p: 'Write a Nuclei YAML template to detect the following vulnerability on AUTHORIZED targets only: [describe vuln here]. Follow nuclei conventions: id, info block, http requests with matchers and extractors.' },
  { t: 'Bug Bounty Report', p: 'Draft a professional bug-bounty report for this finding: [describe finding]. Include: title, severity with reasoning, steps to reproduce, impact within authorized scope, and remediation.' },
  { t: 'Pre-submit Security Review', p: 'Review my changes for security issues before I submit: look for hardcoded secrets, injection flaws, auth bypass, insecure crypto, broken access control, and logic flaws. Be strict and specific.' },
  { t: 'Log Forensics', p: 'Analyze these logs for signs of compromise: brute-force attempts, injection probes, anomalous access patterns. Build a timeline of suspicious events and suggest next investigation steps.' },
];
function renderPrompts() {
  const box = $('prompt-list'); box.innerHTML = '';
  PROMPTS.forEach(pr => {
    const d = document.createElement('div'); d.className = 'prompt';
    d.innerHTML = `<div class="pt">${pr.t}</div><div class="pp"></div>`;
    d.querySelector('.pp').textContent = pr.p;
    const row = document.createElement('div'); row.className = 'row';
    const cp = document.createElement('button'); cp.className = 'btn ghost small'; cp.textContent = '⧉ copy';
    cp.onclick = async () => { try { await navigator.clipboard.writeText(pr.p); cp.textContent = '✓ copied'; } catch { cp.textContent = '✖ failed'; } setTimeout(() => cp.textContent = '⧉ copy', 1500); };
    const sd = document.createElement('button'); sd.className = 'btn small'; sd.textContent = '▶ send to opencode';
    sd.onclick = async () => {
      sd.disabled = true;
      const r = await window.rogue.promptSend(pr.p);
      sd.disabled = false;
      if (r.ok) { sd.textContent = r.isNew ? '✓ sent — new session in OpenCode' : '✓ sent to your OpenCode chat'; setTimeout(() => sd.textContent = '▶ send to opencode', 2500); showView('view-opencode'); }
      else { sd.textContent = '✖ ' + r.error; setTimeout(() => sd.textContent = '▶ send to opencode', 3000); }
    };
    row.appendChild(cp); row.appendChild(sd);
    d.appendChild(row); box.appendChild(d);
  });
}

// ---------- Custom agents manager ----------
let selectedAgent = null;
async function loadAgents() {
  const box = $('agents-list');
  box.innerHTML = '<div class="kv"><span>loading…</span><b>—</b></div>';
  const r = await window.rogue.agentsList();
  if (!r.ok) { box.innerHTML = `<div class="kv"><span>error</span><b class="warn">${r.error}</b></div>`; return; }
  const list = r.agents || [];
  if (!list.length) { box.innerHTML = '<div class="kv"><span>no custom agents yet</span><b>—</b></div>'; return; }
  box.innerHTML = '';
  list.forEach(n => {
    const d = document.createElement('div');
    d.className = 'kv' + (selectedAgent === n ? ' selected' : '');
    d.innerHTML = `<span>@${n}${n === 'hunter' ? ' · built-in' : ''}</span>`;
    d.style.cursor = 'pointer';
    d.onclick = () => { selectedAgent = n; loadAgents(); };
    box.appendChild(d);
  });
}
const AGENT_TEMPLATE = `---
description: What this agent does
mode: subagent
temperature: 0.3
---

You are a specialist subagent. Define your role, rules, and output format here.
`;
$('agent-new').addEventListener('click', () => {
  selectedAgent = null;
  $('agent-name').value = '';
  $('agent-editor').value = AGENT_TEMPLATE;
  $('agent-editor').style.display = '';
  $('agent-editor-row').style.display = 'flex';
  $('agent-name').focus();
});
$('agent-edit').addEventListener('click', async () => {
  if (!selectedAgent) { setStatus($('agents-status'), 'Select an agent from the list first.', 'err'); return; }
  const r = await window.rogue.agentsRead(selectedAgent);
  if (!r.ok) { setStatus($('agents-status'), '✖ ' + r.error, 'err'); return; }
  $('agent-name').value = selectedAgent;
  $('agent-editor').value = r.content;
  $('agent-editor').style.display = '';
  $('agent-editor-row').style.display = 'flex';
});
$('agent-cancel').addEventListener('click', () => {
  $('agent-editor').style.display = 'none';
  $('agent-editor-row').style.display = 'none';
  setStatus($('agents-status'), '', '');
});
$('agent-save').addEventListener('click', async () => {
  const name = $('agent-name').value.trim();
  const r = await window.rogue.agentsSave(name, $('agent-editor').value);
  if (r.ok) {
    setStatus($('agents-status'), `✓ agent @${name} saved — restart the engine to use it.`, 'ok');
    toast('agent saved ✓');
    $('agent-editor').style.display = 'none';
    $('agent-editor-row').style.display = 'none';
    selectedAgent = name;
    loadAgents();
  } else setStatus($('agents-status'), '✖ ' + r.error, 'err');
});
$('agent-delete').addEventListener('click', async () => {
  const name = $('agent-name').value.trim() || selectedAgent;
  if (!name) return;
  if (!(await confirmDialog('Delete agent?', `Delete agent @${name}? This cannot be undone.`))) return;
  const r = await window.rogue.agentsDelete(name);
  if (r.ok) {
    setStatus($('agents-status'), `✓ agent @${name} deleted.`, 'ok');
    toast('agent deleted');
    $('agent-editor').style.display = 'none';
    $('agent-editor-row').style.display = 'none';
    selectedAgent = null;
    loadAgents();
  } else setStatus($('agents-status'), '✖ ' + r.error, 'err');
});

// ---------- Theme (dark / light) ----------
function applyTheme() {
  const t = appSettings.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  const b = $('btn-theme');
  b.textContent = t === 'light' ? '☾' : '☀';
  b.title = t === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
}
$('btn-theme').addEventListener('click', () => {
  appSettings.theme = appSettings.theme === 'light' ? 'dark' : 'light';
  applyTheme(); saveSettings();
});

// ---------- Cheatsheet ----------
const csBox = $('cheatsheet');
function toggleCheatsheet(force) {
  const show = force !== undefined ? force : csBox.style.display !== 'flex';
  csBox.style.display = show ? 'flex' : 'none';
}
$('btn-cheatsheet').addEventListener('click', () => toggleCheatsheet(true));
$('cheatsheet-close').addEventListener('click', () => toggleCheatsheet(false));
csBox.addEventListener('click', e => { if (e.target === csBox) toggleCheatsheet(false); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') toggleCheatsheet(false);
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === '?') { e.preventDefault(); toggleCheatsheet(); }
});

// ---------- Model quick-switch (OpenCode toolbar) ----------
// Provider source of truth: the live engine's /provider list when the engine
// is running (it sees auth.json keys, env-var keys AND config providers),
// else the merged auth.json + env + config list. The opencode free provider
// is always available, so this never shows "no provider" while models exist.
async function refreshQuickModel() {
  const sel = $('oc-model-quick');
  const cfg = (await window.rogue.configGet()).config || {};
  const cur = cfg.model || '';
  const curProv = cur.includes('/') ? cur.split('/')[0] : null;
  let ids = connectedProviders.slice();
  let modelsByProv = {};
  try {
    const r = await window.rogue.providerConfigured();
    if (r.ok && r.providers && r.providers.length) {
      ids = r.providers.map(p => p.id);
      r.providers.forEach(p => { if (p.models) modelsByProv[p.id] = p.models.map(m => p.id + '/' + m); });
    }
  } catch {}
  const prov = (curProv && ids.includes(curProv)) ? curProv : ids[0];
  if (!prov) { sel.innerHTML = '<option value="">no provider</option>'; return; }
  if (modelsByProv[prov]) {
    sel.innerHTML = modelsByProv[prov].map(m => `<option value="${m}"${m === cur ? ' selected' : ''}>${m}</option>`).join('');
    sel.title = `Default model (${prov}) — change applies after engine restart`;
    return;
  }
  sel.innerHTML = '<option>loading…</option>';
  const r = await window.rogue.engineModels(prov);
  if (!r.ok) { sel.innerHTML = `<option value="">${prov}: unavailable</option>`; return; }
  sel.innerHTML = r.models.map(m => `<option value="${m}"${m === cur ? ' selected' : ''}>${m}</option>`).join('');
  sel.title = `Default model (${prov}) — change applies after engine restart`;
}
$('oc-model-quick').addEventListener('change', async e => {
  const m = e.target.value;
  if (!m) return;
  const r = await window.rogue.configSetModel(m);
  if (r.ok) toast('default model updated — restart engine to apply ✓');
  else toast('failed: ' + r.error, false);
});

// ---------- Auto-backup ----------
function updateBackupUI() {
  $('backup-auto-state').textContent = appSettings.backupEnabled ? 'on (weekly)' : 'off';
  $('backup-auto-state').className = appSettings.backupEnabled ? 'ok' : 'warn';
  const bd = $('backup-dir');
  bd.textContent = appSettings.backupDir || '—';
  bd.title = appSettings.backupDir || '';
  $('backup-last').textContent = appSettings.lastBackup ? new Date(appSettings.lastBackup).toLocaleString() : '—';
  $('backup-auto-toggle').textContent = appSettings.backupEnabled ? 'disable auto' : 'enable auto';
}
$('backup-dir-pick').addEventListener('click', async () => {
  const r = await window.rogue.backupPickDir();
  if (r.ok) { appSettings.backupDir = r.path; saveSettings(); updateBackupUI(); toast('backup folder set ✓'); }
});
$('backup-auto-toggle').addEventListener('click', () => {
  if (appSettings.backupEnabled) {
    appSettings.backupEnabled = false; saveSettings(); updateBackupUI();
    setStatus($('backup-status'), 'auto-backup disabled', '');
  } else {
    if (!appSettings.backupDir) { setStatus($('backup-status'), 'Choose a backup folder first.', 'err'); return; }
    appSettings.backupEnabled = true; saveSettings(); updateBackupUI();
    setStatus($('backup-status'), '✓ auto-backup enabled (weekly)', 'ok');
    toast('auto-backup enabled ✓');
  }
});
async function maybeAutoBackup() {
  if (!appSettings.backupEnabled || !appSettings.backupDir) return;
  if (appSettings.lastBackup && Date.now() - appSettings.lastBackup < 7 * 24 * 3600 * 1000) return;
  const r = await window.rogue.backupAuto();
  if (r.ok) {
    appSettings.lastBackup = Date.now(); saveSettings(); updateBackupUI();
    toast('weekly auto-backup complete ✓');
  }
}

// ---------- init ----------
(async () => {
  try { const v = await window.rogue.appVersion(); if (v && v.ok) document.getElementById('app-ver').textContent = 'v' + v.version; } catch {}
  await loadSettings();
  await refreshProviders();
  await refreshQuickModel();
  if (appSettings.dailyBudget) $('budget-input').value = appSettings.dailyBudget;
  maybeAutoBackup();
  if (appSettings.autoBoot && appSettings.recentFolders.length) {
    ocFolder = appSettings.recentFolders[0];
    $('oc-folder').textContent = ocFolder;
    setTimeout(() => bootEngine(), 800);
  }
})();
