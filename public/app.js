const state = {
  mode: "hybrid",
  view: "activity",
  lastTopic: null,
  growth: null,
  growthChart: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function fmt(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function dateText(value) {
  if (!value) return "";
  const date = new Date(String(value).replace("+00:00", "Z"));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function dateShort(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function dateFull(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function fmtFixed(value, digits = 1) {
  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function clip(value, length = 380) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

function setView(view) {
  state.view = view;
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
}

function topicLink(corpus, topicId, label) {
  if (!topicId) return escapeHtml(label || "Untitled");
  return `<a href="#" data-topic="${escapeHtml(topicId)}" data-corpus="${escapeHtml(corpus || "ifsqn")}">${escapeHtml(label || `Topic ${topicId}`)}</a>`;
}

async function loadHealth() {
  const health = await getJson("/health");
  const parts = health.corpora.map((item) => `${item.corpus.toUpperCase()} db:${item.db ? "ok" : "missing"} fts:${item.fts ? "ok" : "missing"}`);
  $("#health-line").textContent = `${parts.join(" | ")} | OpenAI ${health.openai_configured ? "configured" : "not configured"}`;
}

async function loadOverview() {
  const range = $("#range-hours").value;
  const overview = await getJson(`/api/activity/overview?rangeHours=${encodeURIComponent(range)}`);
  $("#metric-events").textContent = fmt(overview.total_events);
  $("#metric-members").textContent = fmt(overview.unique_member_ids);
  $("#metric-topics").textContent = fmt(overview.distinct_topics);
  $("#metric-snapshots").textContent = fmt(overview.completed_snapshots);
}

function renderActivityRows(container, rows, options = {}) {
  const corpus = options.corpus || "ifsqn";
  container.innerHTML = rows.map((row) => `
    <article class="row">
      <div>
        <div class="row-title">${topicLink(corpus, row.topic_id, row.title || `Topic ${row.topic_id}`)}</div>
        <div class="row-meta">
          ${escapeHtml(row.forum_title || row.category_title || "Unknown forum")}
          ${row.latest_activity_utc ? ` | latest ${escapeHtml(dateText(row.latest_activity_utc))}` : ""}
          ${row.snapshots_seen ? ` | ${fmt(row.snapshots_seen)} snapshots` : ""}
          ${row.member_observations ? ` | ${fmt(row.member_observations)} member observations` : ""}
        </div>
      </div>
      <div class="count">${fmt(row.observations ?? row.active_now ?? row.snapshots_seen ?? 0)}</div>
    </article>
  `).join("");
}

async function loadActivity() {
  const range = $("#range-hours").value;
  const sort = $("#activity-sort").value;
  const [topics, activeNow, members] = await Promise.all([
    getJson(`/api/activity/topics?rangeHours=${encodeURIComponent(range)}&sort=${encodeURIComponent(sort)}&limit=30`),
    getJson("/api/activity/active-now"),
    getJson(`/api/activity/members?rangeHours=${encodeURIComponent(range)}`),
  ]);

  renderActivityRows($("#activity-list"), topics.topics);
  renderActivityRows($("#active-now-list"), activeNow.topics);
  $("#member-list").innerHTML = members.members.slice(0, 12).map((member) => `
    <article class="row">
      <div>
        <div class="row-title">
          ${member.profile_url
            ? `<a href="${escapeHtml(member.profile_url)}" target="_blank" rel="noreferrer">${escapeHtml(member.display_name || `Member ${member.member_id}`)}</a>`
            : escapeHtml(member.display_name || `Member ${member.member_id}`)}
        </div>
        <div class="row-meta">
          Member ${escapeHtml(member.member_id)}
          ${member.group_title ? ` | ${escapeHtml(member.group_title)}` : ""}
          ${member.country ? ` | ${escapeHtml(member.country)}` : ""}
          ${member.active_posts ? ` | ${fmt(member.active_posts)} posts` : ""}
          ${member.profile_views ? ` | ${fmt(member.profile_views)} profile views` : ""}
          <br>
          ${fmt(member.snapshots_seen)} snapshots | latest ${escapeHtml(dateText(member.latest_activity_utc))}
        </div>
      </div>
      <div class="count">${fmt(member.observations)}</div>
    </article>
  `).join("");
}

function linePath(points, xScale, yScale, key) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${xScale(index).toFixed(2)} ${yScale(Number(point[key] || 0)).toFixed(2)}`)
    .join(" ");
}

function setGrowthHover(index) {
  const meta = state.growthChart;
  if (!meta) return;

  const point = meta.points[index];
  const svg = $("#growth-chart");
  const tooltip = $("#growth-tooltip");
  const crosshair = svg.querySelector("#growth-crosshair");
  if (!point || !tooltip || !crosshair) return;

  const x = meta.xScale(index);
  const yPosts = meta.yPosts(Number(point.posts_ma30 || 0));
  const yTopics = meta.yTopics(Number(point.new_topics_ma30 || 0));
  crosshair.classList.remove("hidden");
  crosshair.querySelector(".chart-crosshair-line").setAttribute("x1", x);
  crosshair.querySelector(".chart-crosshair-line").setAttribute("x2", x);
  crosshair.querySelector(".chart-point.posts").setAttribute("cx", x);
  crosshair.querySelector(".chart-point.posts").setAttribute("cy", yPosts);
  crosshair.querySelector(".chart-point.topics").setAttribute("cx", x);
  crosshair.querySelector(".chart-point.topics").setAttribute("cy", yTopics);

  const rect = svg.getBoundingClientRect();
  const chartLeft = (x / meta.width) * rect.width;
  const chartTop = (Math.min(yPosts, yTopics) / meta.height) * rect.height;
  tooltip.style.left = `${chartLeft}px`;
  tooltip.style.top = `${Math.max(24, Math.min(rect.height - 24, chartTop))}px`;
  tooltip.dataset.side = x > meta.width * 0.68 ? "left" : "right";
  tooltip.classList.remove("hidden");
  tooltip.innerHTML = `
    <strong>${escapeHtml(dateFull(point.date))}</strong>
    <dl>
      <dt>Posts/day, 30d avg</dt>
      <dd>${fmtFixed(point.posts_ma30)}</dd>
      <dt>Topics/day, 30d avg</dt>
      <dd>${fmtFixed(point.new_topics_ma30)}</dd>
      <dt>Posts that day</dt>
      <dd>${fmt(point.posts)}</dd>
      <dt>New topics that day</dt>
      <dd>${fmt(point.new_topics)}</dd>
    </dl>
  `;
}

function clearGrowthHover() {
  const crosshair = $("#growth-chart")?.querySelector("#growth-crosshair");
  crosshair?.classList.add("hidden");
  $("#growth-tooltip")?.classList.add("hidden");
}

function handleGrowthPointer(event) {
  const meta = state.growthChart;
  if (!meta || meta.points.length === 0) return;

  const rect = event.currentTarget.getBoundingClientRect();
  const viewX = ((event.clientX - rect.left) / rect.width) * meta.width;
  const rawIndex = Math.round(((viewX - meta.margin.left) / meta.innerWidth) * (meta.points.length - 1));
  const index = Math.max(0, Math.min(meta.points.length - 1, rawIndex));
  setGrowthHover(index);
}

function renderGrowthChart(payload) {
  state.growth = payload;
  const svg = $("#growth-chart");
  const points = payload.series || [];
  if (points.length === 0) {
    svg.innerHTML = "";
    $("#growth-summary").textContent = "No dated IFSQN posts found.";
    $("#growth-stat-grid").innerHTML = "";
    clearGrowthHover();
    return;
  }

  const width = 920;
  const height = 380;
  const margin = { top: 22, right: 64, bottom: 42, left: 58 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const maxPosts = Math.max(1, ...points.map((point) => Number(point.posts_ma30 || 0)));
  const maxTopics = Math.max(1, ...points.map((point) => Number(point.new_topics_ma30 || 0)));
  const xScale = (index) => margin.left + (points.length === 1 ? 0 : (index / (points.length - 1)) * innerWidth);
  const yPosts = (value) => margin.top + innerHeight - (value / maxPosts) * innerHeight;
  const yTopics = (value) => margin.top + innerHeight - (value / maxTopics) * innerHeight;
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const xTickIndexes = Array.from(new Set([0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(ratio * (points.length - 1)))));

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <line class="axis-line" x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${margin.left + innerWidth}" y2="${margin.top + innerHeight}"></line>
    <line class="axis-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}"></line>
    <line class="axis-line" x1="${margin.left + innerWidth}" y1="${margin.top}" x2="${margin.left + innerWidth}" y2="${margin.top + innerHeight}"></line>
    ${yTicks.map((tick) => {
      const y = margin.top + innerHeight - tick * innerHeight;
      return `
        <line class="grid-line" x1="${margin.left}" y1="${y}" x2="${margin.left + innerWidth}" y2="${y}"></line>
        <text class="axis-label" x="${margin.left - 10}" y="${y + 4}" text-anchor="end">${Math.round(maxPosts * tick)}</text>
        <text class="axis-label" x="${margin.left + innerWidth + 10}" y="${y + 4}">${Math.round(maxTopics * tick)}</text>
      `;
    }).join("")}
    ${xTickIndexes.map((index) => `
      <text class="axis-label" x="${xScale(index)}" y="${height - 12}" text-anchor="middle">${escapeHtml(dateShort(points[index].date))}</text>
    `).join("")}
    <text class="axis-label" x="${margin.left}" y="14">posts/day</text>
    <text class="axis-label" x="${margin.left + innerWidth}" y="14" text-anchor="end">topics/day</text>
    <path class="chart-line posts" d="${linePath(points, xScale, yPosts, "posts_ma30")}"></path>
    <path class="chart-line topics" d="${linePath(points, xScale, yTopics, "new_topics_ma30")}"></path>
    <g id="growth-crosshair" class="chart-crosshair hidden">
      <line class="chart-crosshair-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}"></line>
      <circle class="chart-point posts" cx="${margin.left}" cy="${margin.top + innerHeight}" r="4"></circle>
      <circle class="chart-point topics" cx="${margin.left}" cy="${margin.top + innerHeight}" r="4"></circle>
    </g>
    <rect class="chart-hit-area" x="${margin.left}" y="${margin.top}" width="${innerWidth}" height="${innerHeight}"></rect>
  `;
  state.growthChart = { points, width, height, margin, innerWidth, yPosts, yTopics, xScale };
  svg.onpointermove = handleGrowthPointer;
  svg.onpointerleave = clearGrowthHover;
}

async function loadGrowth() {
  const range = $("#growth-range").value;
  const payload = await getJson(`/api/ifsqn/growth?rangeDays=${encodeURIComponent(range)}`);
  const summary = payload.summary;
  $("#growth-summary").textContent = `${summary.first_date} to ${summary.last_date} | 30-day moving average shown`;
  $("#growth-stat-grid").innerHTML = `
    <div class="mini-metric">
      <span>Total posts</span>
      <strong>${fmt(summary.total_posts)}</strong>
    </div>
    <div class="mini-metric">
      <span>Total new topics</span>
      <strong>${fmt(summary.total_new_topics)}</strong>
    </div>
    <div class="mini-metric">
      <span>Current 30d posts/day</span>
      <strong>${Number(summary.avg_posts_30d || 0).toFixed(1)}</strong>
    </div>
    <div class="mini-metric">
      <span>Current 30d topics/day</span>
      <strong>${Number(summary.avg_new_topics_30d || 0).toFixed(1)}</strong>
    </div>
  `;
  renderGrowthChart(payload);
}

function searchUrl() {
  const params = new URLSearchParams({
    q: $("#search-query").value,
    corpus: $("#corpus").value,
    mode: state.mode,
    limit: $("#result-limit").value,
    candidates: $("#candidate-limit").value,
  });
  const topicId = $("#topic-filter").value.trim();
  if (topicId) params.set("topic_id", topicId);
  return `/api/search?${params.toString()}`;
}

function renderSearchResults(payload) {
  $("#search-status").textContent = `${fmt(payload.results.length)} results | ${payload.searched_corpora.map((item) => `${item.corpus}: ${item.keyword_candidates} keyword, ${item.vector_candidates} vector`).join(" | ")}`;
  $("#search-results").innerHTML = payload.results.map((result) => `
    <article class="result">
      <div class="badges">
        <span class="badge">${escapeHtml(result.corpus.toUpperCase())}</span>
        ${result.matched_by.map((item) => `<span class="badge ${escapeHtml(item)}">${escapeHtml(item)}</span>`).join("")}
        <span class="badge">score ${escapeHtml(result.score)}</span>
      </div>
      <div class="result-title">${topicLink(result.corpus, result.topic_id, result.topic_title || `Post ${result.post_id}`)}</div>
      <div class="result-meta">
        ${escapeHtml(result.forum_title || result.category_title || "Unknown forum")}
        ${result.author_name ? ` | ${escapeHtml(result.author_name)}` : ""}
        ${result.posted_at ? ` | ${escapeHtml(dateText(result.posted_at))}` : ""}
        ${result.url ? ` | <a href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">source</a>` : ""}
      </div>
      <div class="result-text">${escapeHtml(clip(result.snippet || result.text))}</div>
    </article>
  `).join("");
}

async function runSearch() {
  const query = $("#search-query").value.trim();
  if (!query) {
    $("#search-status").textContent = "Enter a query and run search.";
    $("#search-results").innerHTML = "";
    setView("search");
    return;
  }

  setView("search");
  $("#search-status").textContent = "Searching...";
  $("#search-results").innerHTML = "";
  try {
    renderSearchResults(await getJson(searchUrl()));
  } catch (error) {
    $("#search-status").textContent = error.message;
  }
}

async function loadTopic(corpus, topicId) {
  setView("topic");
  state.lastTopic = { corpus, topicId };
  $("#topic-title").textContent = `Topic ${topicId}`;
  $("#topic-meta").textContent = "Loading...";
  $("#topic-posts").innerHTML = "";
  $("#topic-source").classList.add("hidden");

  const payload = await getJson(`/api/topics/${encodeURIComponent(corpus)}/${encodeURIComponent(topicId)}`);
  const topic = payload.topic;
  $("#topic-title").textContent = topic?.title || `Topic ${topicId}`;
  $("#topic-meta").textContent = topic
    ? `${payload.corpus.toUpperCase()} | ${topic.forum_title || topic.category_title || "Unknown forum"} | ${fmt(topic.post_count)} posts`
    : "Topic metadata not found.";
  if (topic?.url) {
    $("#topic-source").href = topic.url;
    $("#topic-source").classList.remove("hidden");
  }
  $("#topic-posts").innerHTML = payload.posts.map((post) => `
    <article class="post">
      <div class="post-meta">
        Post ${escapeHtml(post.post_no || post.post_id)}
        ${post.author_name ? ` | ${escapeHtml(post.author_name)}` : ""}
        ${post.posted_at ? ` | ${escapeHtml(dateText(post.posted_at))}` : ""}
        ${post.post_url ? ` | <a href="${escapeHtml(post.post_url)}" target="_blank" rel="noreferrer">source</a>` : ""}
      </div>
      <div class="post-text">${escapeHtml(post.text)}</div>
    </article>
  `).join("");
}

async function refreshAll() {
  await Promise.all([loadHealth(), loadOverview(), loadActivity(), loadGrowth()]);
}

$$(".tab").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

$$(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    $$(".segment").forEach((item) => item.classList.toggle("active", item === button));
  });
});

$("#refresh-btn").addEventListener("click", refreshAll);
$("#range-hours").addEventListener("change", refreshAll);
$("#growth-range").addEventListener("change", loadGrowth);
$("#activity-sort").addEventListener("change", loadActivity);
$("#search-btn").addEventListener("click", runSearch);
$("#search-query").addEventListener("keydown", (event) => {
  if (event.key === "Enter") runSearch();
});

document.body.addEventListener("click", (event) => {
  const target = event.target.closest("[data-topic]");
  if (!target) return;
  event.preventDefault();
  loadTopic(target.dataset.corpus || "ifsqn", target.dataset.topic);
});

refreshAll().catch((error) => {
  $("#health-line").textContent = error.message;
});
