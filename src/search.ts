import type { AppConfig, CorpusConfig, CorpusName, SearchMode } from "./config.js";
import { getCorpora } from "./config.js";
import { sqlLiteral, sqliteJson } from "./sqlite.js";

type SearchFilters = {
  topic_id?: number;
  forum_id?: number;
  author_name?: string;
  category_title?: string;
  forum_title?: string;
};

type SearchInput = {
  query: string;
  corpus: CorpusName | "both";
  mode: SearchMode;
  top_k: number;
  candidate_k: number;
  filters: SearchFilters;
};

type QdrantPoint = {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
};

type KeywordRow = {
  post_id: number | string | null;
  topic_id: number | string | null;
  forum_id: number | string | null;
  topic_title: string | null;
  forum_title: string | null;
  category_title: string | null;
  author_name: string | null;
  posted_at: string | null;
  source_url: string | null;
  post_url: string | null;
  topic_url: string | null;
  keyword_rank: number;
  snippet: string | null;
  text: string;
};

export type SearchResult = {
  rank: number;
  corpus: CorpusName;
  score: number;
  vector_score: number | null;
  keyword_score: number | null;
  lexical_score: number;
  matched_by: Array<"vector" | "keyword">;
  reason: string;
  id: string | number;
  post_id: number | string | null;
  topic_id: number | string | null;
  topic_title: string | null;
  forum_title: string | null;
  category_title: string | null;
  author_name: string | null;
  posted_at: string | null;
  url: string | null;
  snippet: string | null;
  text: string;
};

type Candidate = {
  vector?: SearchResult;
  keyword?: SearchResult;
  vectorRank?: number;
  keywordRank?: number;
  keywordRawRank?: number;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asScalar(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function tokenize(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  ));
}

function lexicalScore(values: Array<string | null | undefined>, query: string): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return 0;
  }
  const haystack = values.filter((value): value is string => typeof value === "string").join("\n").toLowerCase();
  const hits = tokens.reduce((count, token) => count + (haystack.includes(token) ? 1 : 0), 0);
  return hits / tokens.length;
}

function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildFtsMatchQuery(query: string): string {
  const stopwords = new Set(["and", "are", "for", "from", "has", "have", "the", "this", "that", "with", "you", "your"]);
  const tokens = tokenize(query).filter((token) => !stopwords.has(token));
  return tokens.length > 0 ? tokens.map(ftsPhrase).join(" OR ") : ftsPhrase(query.trim());
}

function buildKeywordWhere(matchQuery: string, filters: SearchFilters): string {
  const clauses = [`posts_fts MATCH ${sqlLiteral(matchQuery)}`];
  if (filters.topic_id) clauses.push(`topic_id = ${sqlLiteral(filters.topic_id)}`);
  if (filters.forum_id) clauses.push(`forum_id = ${sqlLiteral(filters.forum_id)}`);
  if (filters.author_name) clauses.push(`author_name = ${sqlLiteral(filters.author_name)}`);
  if (filters.category_title) clauses.push(`category_title = ${sqlLiteral(filters.category_title)}`);
  if (filters.forum_title) clauses.push(`forum_title = ${sqlLiteral(filters.forum_title)}`);
  return clauses.join(" AND ");
}

function buildQdrantFilter(filters: SearchFilters) {
  const must: Array<{ key: string; match: { value: string | number } }> = [];
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.trim().length > 0) {
      must.push({ key, match: { value: value.trim() } });
    } else if (typeof value === "number" && Number.isFinite(value)) {
      must.push({ key, match: { value } });
    }
  }
  return must.length > 0 ? { must } : undefined;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} ${response.statusText}: ${text.slice(0, 600)}`);
  }
  return payload;
}

async function embedQuery(config: AppConfig, query: string): Promise<number[]> {
  if (!config.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for vector or hybrid search.");
  }
  const payload = await fetchJson("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: config.OPENAI_EMBEDDING_MODEL, input: query }),
  }) as { data?: Array<{ embedding?: number[] }> };

  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("OpenAI embedding response did not include an embedding.");
  }
  return embedding;
}

async function searchQdrant(corpus: CorpusConfig, vector: number[], input: SearchInput): Promise<QdrantPoint[]> {
  const url = new URL(`/collections/${encodeURIComponent(corpus.collection)}/points/search`, corpus.qdrantUrl);
  const payload = await fetchJson(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      vector,
      limit: input.candidate_k,
      with_payload: true,
      with_vector: false,
      filter: buildQdrantFilter(input.filters),
    }),
  }) as { result?: QdrantPoint[] };

  if (!Array.isArray(payload.result)) {
    throw new Error("Qdrant search response did not include result points.");
  }
  return payload.result;
}

async function searchKeyword(config: AppConfig, corpus: CorpusConfig, input: SearchInput): Promise<KeywordRow[]> {
  const where = buildKeywordWhere(buildFtsMatchQuery(input.query), input.filters);
  const sql = `
    SELECT
      post_id,
      topic_id,
      forum_id,
      topic_title,
      forum_title,
      category_title,
      author_name,
      posted_at,
      source_url,
      post_url,
      topic_url,
      bm25(posts_fts) AS keyword_rank,
      snippet(posts_fts, 3, '[', ']', ' ... ', 34) AS snippet,
      text
    FROM posts_fts
    WHERE ${where}
    ORDER BY keyword_rank
    LIMIT ${input.candidate_k}
  `;

  return sqliteJson<Record<string, unknown>>(config, corpus.ftsDbPath, sql).then((rows) => rows.map((row) => ({
    post_id: asScalar(row.post_id),
    topic_id: asScalar(row.topic_id),
    forum_id: asScalar(row.forum_id),
    topic_title: asString(row.topic_title),
    forum_title: asString(row.forum_title),
    category_title: asString(row.category_title),
    author_name: asString(row.author_name),
    posted_at: asString(row.posted_at),
    source_url: asString(row.source_url),
    post_url: asString(row.post_url),
    topic_url: asString(row.topic_url),
    keyword_rank: asNumber(row.keyword_rank) ?? 0,
    snippet: asString(row.snippet),
    text: asString(row.text) ?? "",
  })));
}

function sourceUrl(payload: Record<string, unknown>): string | null {
  return asString(payload.post_url) ?? asString(payload.source_url) ?? asString(payload.topic_url);
}

function resultKey(corpus: CorpusName, postId: string | number | null, fallback: string | number): string {
  return `${corpus}:${postId ?? fallback}`;
}

function vectorToResult(corpus: CorpusName, point: QdrantPoint, query: string): SearchResult {
  const payload = point.payload ?? {};
  const text = asString(payload.text) ?? "";
  const topicTitle = asString(payload.topic_title) ?? asString(payload.post_title);
  const lexical = lexicalScore([
    topicTitle,
    asString(payload.forum_title),
    asString(payload.category_title),
    asString(payload.author_name),
    text,
  ], query);

  return {
    rank: 0,
    corpus,
    score: 0,
    vector_score: Number(point.score.toFixed(6)),
    keyword_score: null,
    lexical_score: Number(lexical.toFixed(6)),
    matched_by: ["vector"],
    reason: "Semantic vector match",
    id: point.id,
    post_id: asScalar(payload.post_id),
    topic_id: asScalar(payload.topic_id),
    topic_title: topicTitle,
    forum_title: asString(payload.forum_title),
    category_title: asString(payload.category_title),
    author_name: asString(payload.author_name),
    posted_at: asString(payload.posted_at),
    url: sourceUrl(payload),
    snippet: null,
    text,
  };
}

function keywordToResult(corpus: CorpusName, row: KeywordRow, query: string): SearchResult {
  const lexical = lexicalScore([row.topic_title, row.forum_title, row.category_title, row.author_name, row.text], query);
  return {
    rank: 0,
    corpus,
    score: 0,
    vector_score: null,
    keyword_score: null,
    lexical_score: Number(lexical.toFixed(6)),
    matched_by: ["keyword"],
    reason: "Exact keyword/BM25 match",
    id: row.post_id ?? `${row.topic_id ?? "unknown"}:keyword`,
    post_id: row.post_id,
    topic_id: row.topic_id,
    topic_title: row.topic_title,
    forum_title: row.forum_title,
    category_title: row.category_title,
    author_name: row.author_name,
    posted_at: row.posted_at,
    url: row.post_url ?? row.source_url ?? row.topic_url,
    snippet: row.snippet,
    text: row.text,
  };
}

function reciprocalRank(rank: number | undefined): number {
  return rank ? 1 / (60 + rank) : 0;
}

function scoreCandidate(candidate: Candidate): SearchResult {
  const preferred = candidate.vector ?? candidate.keyword;
  if (!preferred) {
    throw new Error("candidate has no result");
  }
  const matchedBy: Array<"vector" | "keyword"> = [];
  if (candidate.vector) matchedBy.push("vector");
  if (candidate.keyword) matchedBy.push("keyword");

  const lexical = Math.max(candidate.vector?.lexical_score ?? 0, candidate.keyword?.lexical_score ?? 0);
  const score = (4 * reciprocalRank(candidate.vectorRank)) + (5 * reciprocalRank(candidate.keywordRank)) + (0.1 * lexical);
  const reason = matchedBy.length === 2
    ? "Matched by both semantic vector search and exact keyword/BM25 search"
    : matchedBy[0] === "keyword" ? "Exact keyword/BM25 match" : "Semantic vector match";

  return {
    ...preferred,
    score: Number(score.toFixed(6)),
    vector_score: candidate.vector?.vector_score ?? null,
    keyword_score: candidate.keyword ? Number((1 / Math.max(1, Math.abs(candidate.keywordRawRank ?? 1))).toFixed(6)) : null,
    lexical_score: Number(lexical.toFixed(6)),
    matched_by: matchedBy,
    reason,
    snippet: candidate.keyword?.snippet ?? candidate.vector?.snippet ?? null,
    text: candidate.vector?.text || candidate.keyword?.text || preferred.text,
  };
}

function mergeResults(corpus: CorpusName, vectors: SearchResult[], keywords: Array<{ result: SearchResult; rawRank: number }>): SearchResult[] {
  const candidates = new Map<string, Candidate>();
  vectors.forEach((result, index) => {
    candidates.set(resultKey(corpus, result.post_id, result.id), { vector: result, vectorRank: index + 1 });
  });
  keywords.forEach(({ result, rawRank }, index) => {
    const key = resultKey(corpus, result.post_id, result.id);
    const existing = candidates.get(key) ?? {};
    existing.keyword = result;
    existing.keywordRank = index + 1;
    existing.keywordRawRank = rawRank;
    candidates.set(key, existing);
  });
  return Array.from(candidates.values()).map(scoreCandidate);
}

function diversify(results: SearchResult[], topK: number): SearchResult[] {
  const seenTopics = new Set<string>();
  const primary: SearchResult[] = [];
  const overflow: SearchResult[] = [];
  for (const result of results) {
    const key = `${result.corpus}:${result.topic_id ?? result.post_id ?? result.id}`;
    if (seenTopics.has(key)) {
      overflow.push(result);
    } else {
      seenTopics.add(key);
      primary.push(result);
    }
  }
  return [...primary, ...overflow].slice(0, topK).map((result, index) => ({ ...result, rank: index + 1 }));
}

export function parseSearchInput(query: Record<string, unknown>): SearchInput {
  const corpus = query.corpus === "ifsqn" || query.corpus === "elsmar" || query.corpus === "both" ? query.corpus : "both";
  const mode = query.mode === "keyword" || query.mode === "vector" || query.mode === "hybrid" ? query.mode : "hybrid";
  const filters: SearchFilters = {};
  if (query.topic_id) filters.topic_id = Number(query.topic_id);
  if (query.forum_id) filters.forum_id = Number(query.forum_id);
  if (typeof query.author_name === "string" && query.author_name.trim()) filters.author_name = query.author_name.trim();
  if (typeof query.category_title === "string" && query.category_title.trim()) filters.category_title = query.category_title.trim();
  if (typeof query.forum_title === "string" && query.forum_title.trim()) filters.forum_title = query.forum_title.trim();

  return {
    query: typeof query.q === "string" ? query.q.trim() : "",
    corpus,
    mode,
    top_k: clampInt(query.limit, 12, 1, 50),
    candidate_k: clampInt(query.candidates, 60, 5, 200),
    filters,
  };
}

export async function searchPosts(config: AppConfig, input: SearchInput) {
  if (!input.query) {
    return { query: "", mode: input.mode, corpus: input.corpus, results: [], searched_corpora: [] };
  }

  const corpora = getCorpora(config, input.corpus);
  const vector = input.mode === "keyword" ? null : await embedQuery(config, input.query);
  const perCorpus = await Promise.all(corpora.map(async (corpus) => {
    const [points, keywordRows] = await Promise.all([
      vector && input.mode !== "keyword" ? searchQdrant(corpus, vector, input) : Promise.resolve([]),
      input.mode !== "vector" ? searchKeyword(config, corpus, input) : Promise.resolve([]),
    ]);
    const vectors = points.map((point) => vectorToResult(corpus.name, point, input.query));
    const keywords = keywordRows.map((row) => ({ result: keywordToResult(corpus.name, row, input.query), rawRank: row.keyword_rank }));
    return {
      corpus: corpus.name,
      vector_candidates: points.length,
      keyword_candidates: keywordRows.length,
      results: mergeResults(corpus.name, vectors, keywords),
    };
  }));

  const ranked = perCorpus.flatMap((item) => item.results).sort((a, b) => b.score - a.score);
  return {
    query: input.query,
    mode: input.mode,
    corpus: input.corpus,
    searched_corpora: perCorpus.map(({ corpus, vector_candidates, keyword_candidates }) => ({ corpus, vector_candidates, keyword_candidates })),
    results: diversify(ranked, input.top_k),
  };
}
