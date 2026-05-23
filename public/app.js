const state = {
  mode: "hybrid",
  view: "activity",
  lastTopic: null,
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
        <div class="row-title">Member ${escapeHtml(member.member_id)}</div>
        <div class="row-meta">${fmt(member.snapshots_seen)} snapshots | latest ${escapeHtml(dateText(member.latest_activity_utc))}</div>
      </div>
      <div class="count">${fmt(member.observations)}</div>
    </article>
  `).join("");
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
  await Promise.all([loadHealth(), loadOverview(), loadActivity()]);
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
