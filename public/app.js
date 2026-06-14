// ─── Chart setup ─────────────────────────────────────────────────────────────

const CHART_SPECS = [
  ["impressions", "impressionsChart", "Impressions", "#0a66c2"],
  ["reactions",   "reactionsChart",   "Likes",       "#16885d"],
  ["comments",    "commentsChart",    "Comments",    "#bd6b00"],
  ["reposts",     "repostsChart",     "Reposts",     "#ba3d4a"]
];

Chart.defaults.font.family = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
Chart.defaults.color = "#667085";

const charts = {};
let currentPosts = [];

for (const [metric, canvasId, label, color] of CHART_SPECS) {
  charts[metric] = new Chart(document.getElementById(canvasId), {
    type: "bar",
    data: {
      labels: [],
      datasets: [{
        label,
        data: [],
        borderColor: color,
        backgroundColor: `${color}24`,
        borderWidth: 2,
        borderRadius: 4,
        hoverBackgroundColor: `${color}44`
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterBody(items) {
              const post = currentPosts[items[0]?.dataIndex ?? -1];
              return post?.textPreview ? `\n${post.textPreview.slice(0, 140)}` : "";
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, ticks: { precision: 0 } }
      },
      onClick(_event, elements) {
        const post = currentPosts[elements[0]?.index];
        if (post?.postUrl) window.open(post.postUrl, "_blank", "noopener,noreferrer");
      }
    }
  });
}

// ─── App state ────────────────────────────────────────────────────────────────

const state = {
  user: null,            // { id, name, email, picture, hasCredentials }
  collections: [],       // all collections (newest first)
  currentId: null,       // selected collection id
  job: null,             // latest job state from SSE
  snapshotCache: {},     // id -> { collectedAt, windowDays, posts }
  stream: null           // EventSource
};

const overlay     = document.getElementById("overlay");
const overlayCard = document.getElementById("overlayCard");
const shell       = document.getElementById("shell");

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
  await loadMe();
  if (state.user?.hasCredentials) await loadCollections();
  route();
})();

async function loadMe() {
  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    const data = await res.json();
    state.user = data.user;
  } catch {
    state.user = null;
  }
}

async function loadCollections() {
  try {
    const res = await fetch("/api/collections", { cache: "no-store" });
    const data = await res.json();
    state.collections = data.collections ?? [];
  } catch {
    state.collections = [];
  }
}

function readyCollections() {
  return state.collections.filter((c) => c.status === "ready");
}

// ─── Router: decides overlay vs dashboard ──────────────────────────────────────

function route() {
  // Not signed in with LinkedIn (OAuth)
  if (!state.user) {
    renderConnect();
    return;
  }

  // Signed in, but no LinkedIn credentials saved yet
  if (!state.user.hasCredentials) {
    renderCredentials();
    return;
  }

  ensureStream();

  const phase = state.job?.phase;
  if (phase === "starting" || phase === "connecting" || phase === "collecting") {
    renderProgress(state.job);
    return;
  }
  if (phase === "error") {
    renderError(state.job?.error || "Something went wrong.");
    return;
  }

  // idle / done — show dashboard if we have data, otherwise prompt to collect
  if (readyCollections().length > 0) {
    showDashboard();
  } else {
    renderCollectPrompt();
  }
}

// ─── Overlay renderers ──────────────────────────────────────────────────────────

function showOverlay(html) {
  overlayCard.innerHTML = html;
  overlay.classList.remove("hidden");
  shell.hidden = true;
}

function hideOverlay() {
  overlay.classList.add("hidden");
  shell.hidden = false;
}

function renderConnect() {
  const params = new URLSearchParams(location.search);
  const authError = params.get("auth_error");
  showOverlay(`
    <div class="ov-icon">📊</div>
    <h2>LinkedIn Post Stats</h2>
    <p>See impressions, likes, comments and reposts for your recent posts — and track how your content grows week over week.</p>
    ${authError ? `<p class="error-msg">${escapeHtml(authError)}</p>` : ""}
    <a class="btn btn-primary btn-lg" href="/auth/linkedin">
      <span>in</span> Connect with LinkedIn
    </a>
    <p class="fine-print">We use LinkedIn sign-in to identify you. Stats collection is set up in the next step.</p>`);
}

function renderCredentials() {
  showOverlay(`
    <div class="ov-icon">🔐</div>
    <h2>Set up stats collection</h2>
    <p>To read your post analytics, the server signs in to LinkedIn as you in a private, invisible browser. Your password is encrypted (AES-256) and used only for this.</p>
    <form class="cred-form" onsubmit="submitCredentials(event)">
      <input id="lnEmail" type="email" placeholder="LinkedIn email" autocomplete="username" required />
      <input id="lnPassword" type="password" placeholder="LinkedIn password" autocomplete="current-password" required />
      <div id="credError" class="error-msg" hidden></div>
      <button type="submit" class="btn btn-primary btn-lg" id="credSubmit">Save &amp; continue</button>
    </form>
    <p class="fine-print">Heads up: LinkedIn may occasionally ask for a one-time security check the first time. Signed in as ${escapeHtml(state.user?.name || "you")} · <a href="#" onclick="logout();return false;">not you?</a></p>`);
}

function renderCollectPrompt() {
  showOverlay(`
    <div class="ov-icon">🚀</div>
    <h2>Ready to collect</h2>
    <p>Pull stats for your posts from the last 30 days. This runs in the background — no browser window opens on your screen.</p>
    <button class="btn btn-primary btn-lg" onclick="triggerCollect()">Collect my stats</button>
    <p class="fine-print">Signed in as ${escapeHtml(state.user?.name || "you")} · <a href="#" onclick="logout();return false;">sign out</a></p>`);
}

function renderProgress(job) {
  const p = job?.progress;
  const showBar = p && p.total > 0;
  const pct = showBar ? Math.round((p.current / p.total) * 100) : 0;
  const heading =
    job?.phase === "connecting" ? "Signing in to LinkedIn" :
    job?.phase === "starting"   ? "Starting up" : "Collecting your stats";

  showOverlay(`
    <div class="spinner"></div>
    <h2>${heading}</h2>
    <p id="collectMsg">${escapeHtml(p?.message || "Working…")}</p>
    ${showBar ? `
      <div class="progress-wrap"><div class="progress-bar" id="progressBar" style="width:${pct}%"></div></div>
      <div class="progress-label" id="progressLabel">${p.current} / ${p.total} posts</div>` : `
      <div class="waiting-dots"><span></span><span></span><span></span></div>`}`);
}

function renderError(message) {
  showOverlay(`
    <div class="ov-icon ov-err">⚠</div>
    <h2>Collection stopped</h2>
    <p class="error-msg">${escapeHtml(message)}</p>
    <div class="ov-actions">
      <button class="btn btn-primary" onclick="triggerCollect()">Try again</button>
      ${readyCollections().length ? `<button class="btn btn-ghost" onclick="showDashboard()">View last results</button>` : ""}
    </div>
    <p class="fine-print"><a href="#" onclick="disconnectLinkedIn();return false;">Re-enter credentials</a></p>`);
}

// ─── SSE stream ─────────────────────────────────────────────────────────────────

function ensureStream() {
  if (state.stream) return;
  const es = new EventSource("/api/stream");
  es.onmessage = (e) => {
    try { handleJob(JSON.parse(e.data)); } catch { /* ignore malformed */ }
  };
  es.onerror = () => { /* browser auto-reconnects */ };
  state.stream = es;
}

function handleJob(job) {
  const prevPhase = state.job?.phase;
  state.job = job;
  updateStatus(job);

  // Once the bar exists (already collecting), just tween it instead of rebuilding
  // the card — but let the FIRST collecting event fall through to a full render so
  // the bar is created.
  if (job.phase === "collecting" && prevPhase === "collecting" && !overlay.classList.contains("hidden")) {
    tweenProgress(job.progress);
    return;
  }

  if (job.phase === "done" && prevPhase && prevPhase !== "done") {
    loadCollections().then(() => {
      const ready = readyCollections();
      if (ready.length) state.currentId = ready[0].id;
      route();
    });
    return;
  }

  route();
}

function tweenProgress(progress) {
  const msg = document.getElementById("collectMsg");
  const bar = document.getElementById("progressBar");
  const label = document.getElementById("progressLabel");
  if (msg) msg.textContent = progress?.message || "Working…";
  if (bar && progress?.total > 0) bar.style.width = `${Math.round((progress.current / progress.total) * 100)}%`;
  if (label && progress?.total > 0) label.textContent = `${progress.current} / ${progress.total} posts`;
}

// ─── Dashboard ──────────────────────────────────────────────────────────────────

async function showDashboard() {
  hideOverlay();
  renderUserChip();

  const ready = readyCollections();
  if (!ready.length) { renderCollectPrompt(); return; }
  if (!state.currentId || !ready.some((c) => c.id === state.currentId)) {
    state.currentId = ready[0].id;
  }

  renderSnapshotSelect();
  await renderCurrent();
}

function renderUserChip() {
  const chip = document.getElementById("userChip");
  if (!state.user) { chip.hidden = true; return; }
  chip.hidden = false;
  const avatar = document.getElementById("userAvatar");
  if (state.user.picture) { avatar.src = state.user.picture; avatar.style.display = ""; }
  else { avatar.style.display = "none"; }
  document.getElementById("userName").textContent = state.user.name || "You";
}

function renderSnapshotSelect() {
  const select = document.getElementById("snapshotSelect");
  const ready = readyCollections();
  select.innerHTML = ready
    .map((c, i) => `<option value="${c.id}" ${c.id === state.currentId ? "selected" : ""}>${fmtDate(c.finishedAt)}${i === 0 ? " (latest)" : ""}</option>`)
    .join("");
}

async function onSnapshotChange() {
  const select = document.getElementById("snapshotSelect");
  state.currentId = Number.parseInt(select.value, 10);
  await renderCurrent();
}

async function fetchSnapshot(id) {
  if (state.snapshotCache[id]) return state.snapshotCache[id];
  const res = await fetch(`/api/collections/${id}`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  state.snapshotCache[id] = data;
  return data;
}

async function renderCurrent() {
  const snapshot = await fetchSnapshot(state.currentId);
  if (!snapshot) return;

  // Previous ready snapshot (older than the current one) for week-over-week.
  const ready = readyCollections();
  const idx = ready.findIndex((c) => c.id === state.currentId);
  const prevMeta = idx >= 0 ? ready[idx + 1] : undefined;
  const prevSnapshot = prevMeta ? await fetchSnapshot(prevMeta.id) : null;

  renderDashboard(snapshot, prevSnapshot);
}

function renderDashboard(payload, prev) {
  currentPosts = normalizePosts(payload.posts ?? []);
  const labels = currentPosts.map((p, i) => `${i + 1}. ${p.postedAtText || "post"}`);

  for (const [metric] of CHART_SPECS) {
    const chart = charts[metric];
    chart.data.labels = labels;
    chart.data.datasets[0].data = currentPosts.map((p) => safeNum(p.stats?.[metric]));
    chart.update();
  }

  const totals = metricTotals(currentPosts);
  setText("totalImpressions", fmt(totals.impressions));
  setText("totalReactions",   fmt(totals.reactions));
  setText("totalComments",    fmt(totals.comments));
  setText("totalReposts",     fmt(totals.reposts));
  setText("postCount",        fmt(currentPosts.length));
  setText("collectedAt",      fmtDate(payload.collectedAt));
  setText("windowDays",       `${payload.windowDays ?? 30} days`);

  const n = currentPosts.length;
  setText("avgImpressions", `Avg ${fmt(avg(totals.impressions, n))}`);
  setText("avgReactions",   `Avg ${fmt(avg(totals.reactions,   n))}`);
  setText("avgComments",    `Avg ${fmt(avg(totals.comments,    n))}`);
  setText("avgReposts",     `Avg ${fmt(avg(totals.reposts,     n))}`);

  const engRate = avgEngagementRate(currentPosts);
  setText("avgEngagement", engRate !== null ? `${engRate.toFixed(1)}%` : "—");

  renderGrowth(currentPosts, prev ? normalizePosts(prev.posts ?? []) : null, prev);
  renderTable(currentPosts);

  const metaEl = document.getElementById("snapshotMeta");
  metaEl.textContent = `${currentPosts.length} posts`;
}

// ─── Week-over-week growth (current snapshot vs previous snapshot) ──────────────

function renderGrowth(posts, prevPosts, prevPayload) {
  const panel = document.getElementById("growthPanel");

  // Trend badges on the summary cards (compare totals vs previous snapshot)
  const curTotals = metricTotals(posts);
  const prevTotals = prevPosts ? metricTotals(prevPosts) : null;
  for (const [key, badgeId] of [
    ["impressions", "trendImpressions"],
    ["reactions",   "trendReactions"],
    ["comments",    "trendComments"],
    ["reposts",     "trendReposts"]
  ]) {
    const el = document.getElementById(badgeId);
    if (!el) continue;
    if (!prevTotals) { el.className = "trend-badge neutral"; el.textContent = ""; continue; }
    const { arrow, cls, pct } = trendInfo(curTotals[key], prevTotals[key]);
    el.className = `trend-badge ${cls}`;
    el.textContent = pct ? `${arrow} ${pct}` : "";
  }

  if (!prevPosts) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "";
  document.getElementById("growthSubtitle").textContent =
    `vs snapshot from ${fmtDate(prevPayload.collectedAt)}`;

  const fmtAvg = (v) => fmt(Math.round(v));
  const metrics = [
    { key: "impressions", label: "Avg Impressions", get: (a) => avgStat(a, "impressions"), fmt: fmtAvg },
    { key: "reactions",   label: "Avg Likes",       get: (a) => avgStat(a, "reactions"),   fmt: fmtAvg },
    { key: "comments",    label: "Avg Comments",    get: (a) => avgStat(a, "comments"),    fmt: fmtAvg },
    { key: "reposts",     label: "Avg Reposts",     get: (a) => avgStat(a, "reposts"),     fmt: fmtAvg },
    { key: "engagement",  label: "Avg Engagement",  get: (a) => avgEngagementRate(a),      fmt: (v) => `${v.toFixed(1)}%` }
  ];

  const grid = document.getElementById("growthGrid");
  grid.innerHTML = metrics.map(({ label, get, fmt: fmtFn }) => {
    const r = get(posts);
    const e = get(prevPosts);
    const { arrow, cls, pct } = trendInfo(r, e);
    return `
      <div class="growth-metric">
        <div class="growth-label">${label}</div>
        <div class="growth-values">
          <div class="growth-col">
            <div class="growth-col-head">Now</div>
            <div class="growth-num">${r !== null ? fmtFn(r) : "—"}</div>
          </div>
          <div class="growth-arrow ${cls}">${arrow}${pct ? `<span class="growth-pct">${pct}</span>` : ""}</div>
          <div class="growth-col">
            <div class="growth-col-head">Before</div>
            <div class="growth-num">${e !== null ? fmtFn(e) : "—"}</div>
          </div>
        </div>
      </div>`;
  }).join("");
}

function avgStat(posts, key) {
  const vals = posts.map((p) => p.stats?.[key]).filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function trendInfo(recent, earlier) {
  if (recent === null || earlier === null || earlier === 0) {
    return { arrow: "→", cls: "neutral", pct: null };
  }
  const delta = ((recent - earlier) / earlier) * 100;
  if (delta > 2)  return { arrow: "↑", cls: "up",   pct: `+${delta.toFixed(0)}%` };
  if (delta < -2) return { arrow: "↓", cls: "down", pct: `${delta.toFixed(0)}%`  };
  return { arrow: "→", cls: "neutral", pct: null };
}

// ─── Table ────────────────────────────────────────────────────────────────────

function renderTable(posts) {
  const tbody = document.getElementById("postsTable");
  tbody.innerHTML = "";
  for (const post of posts) {
    const { impressions, reactions, comments, reposts } = post.stats || {};
    const eng = engagementRate(impressions, reactions, comments, reposts);
    const row = document.createElement("tr");
    row.className = "post-row";
    row.addEventListener("click", () => post.postUrl && window.open(post.postUrl, "_blank", "noopener,noreferrer"));
    row.innerHTML = `
      <td>${escapeHtml(post.postedAtText || "—")}</td>
      <td class="preview">${escapeHtml(post.textPreview || "No preview")}</td>
      <td class="metric">${fmt(safeNum(impressions))}</td>
      <td class="metric">${fmt(safeNum(reactions))}</td>
      <td class="metric">${fmt(safeNum(comments))}</td>
      <td class="metric">${fmt(safeNum(reposts))}</td>
      <td class="metric eng">${eng !== null ? `${eng.toFixed(1)}%` : "—"}</td>`;
    tbody.appendChild(row);
  }
}

// ─── Status bar ─────────────────────────────────────────────────────────────────

function updateStatus(job) {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  if (!dot || !text) return;
  const map = {
    idle:       ["ok",    "Connected"],
    starting:   ["pulse", "Starting…"],
    connecting: ["pulse", "Signing in…"],
    collecting: ["pulse", job?.progress?.total > 0 ? `Collecting ${job.progress.current}/${job.progress.total}` : "Collecting…"],
    done:       ["ok",    "Up to date"],
    error:      ["err",   "Error"]
  };
  const [cls, msg] = map[job?.phase] || ["ok", "Connected"];
  dot.className = `status-dot ${cls}`;
  text.textContent = msg;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function submitCredentials(event) {
  event.preventDefault();
  const email = document.getElementById("lnEmail").value.trim();
  const password = document.getElementById("lnPassword").value;
  const errEl = document.getElementById("credError");
  const btn = document.getElementById("credSubmit");
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const res = await fetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Could not save credentials.");
    }
    state.user.hasCredentials = true;
    // Kick off the first collection immediately.
    await triggerCollect();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    btn.disabled = false;
    btn.textContent = "Save & continue";
  }
}

async function triggerCollect() {
  try {
    const res = await fetch("/api/collect", { method: "POST" });
    if (!res.ok && res.status !== 409) {
      const data = await res.json().catch(() => ({}));
      renderError(data.error || "Could not start collection.");
      return;
    }
    ensureStream();
    // Optimistically show progress; SSE will refine it.
    renderProgress({ phase: "starting", progress: { current: 0, total: 0, message: "Starting…" } });
  } catch {
    renderError("Network error starting collection.");
  }
}

async function logout() {
  try { await fetch("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
  location.href = "/";
}

async function disconnectLinkedIn() {
  if (!confirm("Remove your stored LinkedIn credentials? You'll need to re-enter them to collect again.")) return;
  try { await fetch("/api/credentials", { method: "DELETE" }); } catch { /* ignore */ }
  state.user.hasCredentials = false;
  route();
}

async function deleteAccount() {
  if (!confirm("Delete your account and ALL collected data permanently? This cannot be undone.")) return;
  try { await fetch("/api/account", { method: "DELETE" }); } catch { /* ignore */ }
  location.href = "/";
}

// ─── Server log panel ────────────────────────────────────────────────────────

const logState = {
  stream: null,    // EventSource for /api/logs
  open: false
};

function toggleLogs() {
  const drawer = document.getElementById("logDrawer");
  logState.open = !logState.open;
  drawer.classList.toggle("open", logState.open);
  if (logState.open && !logState.stream) startLogStream();
}

function clearLogs() {
  const el = document.getElementById("logEntries");
  if (el) el.innerHTML = "";
}

function startLogStream() {
  if (logState.stream) return;
  const es = new EventSource("/api/logs");
  es.onmessage = (e) => {
    try { appendLogEntry(JSON.parse(e.data)); } catch { /* ignore */ }
  };
  es.onerror = () => { /* auto-reconnects */ };
  logState.stream = es;
}

function appendLogEntry(entry) {
  const container = document.getElementById("logEntries");
  if (!container) return;

  const empty = container.querySelector(".log-empty");
  if (empty) empty.remove();

  const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 4;

  const ts = new Date(entry.ts);
  const hms = ts.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const div = document.createElement("div");
  div.className = `log-entry ${entry.level}`;
  div.innerHTML = `<span class="log-ts">${hms}</span><span class="log-msg">${escapeHtml(entry.msg)}</span>`;
  container.appendChild(div);

  // Keep max 500 visible entries to avoid DOM bloat
  while (container.childElementCount > 500) container.firstElementChild.remove();

  if (wasAtBottom) container.scrollTop = container.scrollHeight;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function normalizePosts(posts) {
  return [...posts].sort((a, b) => ageRank(a.postedAtText) - ageRank(b.postedAtText));
}

function metricTotals(posts) {
  return posts.reduce(
    (acc, p) => ({
      impressions: acc.impressions + safeNum(p.stats?.impressions),
      reactions:   acc.reactions   + safeNum(p.stats?.reactions),
      comments:    acc.comments    + safeNum(p.stats?.comments),
      reposts:     acc.reposts     + safeNum(p.stats?.reposts)
    }),
    { impressions: 0, reactions: 0, comments: 0, reposts: 0 }
  );
}

function avgEngagementRate(posts) {
  const rates = posts.map((p) => {
    const { impressions, reactions, comments, reposts } = p.stats || {};
    return engagementRate(impressions, reactions, comments, reposts);
  }).filter((v) => v !== null);
  return rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
}

function engagementRate(impressions, reactions, comments, reposts) {
  if (!Number.isFinite(impressions) || impressions === 0) return null;
  const engage = safeNum(reactions) + safeNum(comments) + safeNum(reposts);
  return (engage / impressions) * 100;
}

function ageRank(value) {
  const text = String(value || "").toLowerCase();
  const number = Number.parseInt(text.match(/\d+/)?.[0] || "0", 10);
  if (text.includes("now")) return 0;
  if (text.includes("yr"))  return number * 365;
  if (text.includes("mo"))  return number * 30;
  if (text.includes("w"))   return number * 7;
  if (text.includes("d"))   return number;
  if (text.includes("h"))   return number / 24;
  if (text.includes("m"))   return number / 1440;
  return 9999;
}

function avg(total, count) { return count > 0 ? Math.round(total / count) : 0; }
function safeNum(value) { return Number.isFinite(value) ? value : 0; }
function fmt(value) { return new Intl.NumberFormat().format(value ?? 0); }

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
