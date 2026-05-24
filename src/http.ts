import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, corpusAvailability, getCorpora } from "./config.js";
import { getActiveNow, getActivityOverview, getActivityTopics, getMemberVisits } from "./activity.js";
import { getIfsqnGrowth } from "./growth.js";
import { parseSearchInput, searchPosts } from "./search.js";
import { getTopic } from "./topics.js";

const config = loadConfig();
const app = express();
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir, {
  extensions: ["html"],
  maxAge: "5m",
}));

function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.get("/health", asyncRoute(async (_req, res) => {
  const corpora = getCorpora(config).map(corpusAvailability);
  const qdrant = await Promise.all(getCorpora(config).map(async (corpus) => {
    try {
      const response = await fetch(new URL(`/collections/${encodeURIComponent(corpus.collection)}`, corpus.qdrantUrl));
      return { corpus: corpus.name, ok: response.ok, status: response.status };
    } catch (error) {
      return { corpus: corpus.name, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));

  res.json({
    status: "ok",
    service: "food-forum-dashboard",
    corpora,
    qdrant,
    openai_configured: Boolean(config.OPENAI_API_KEY),
  });
}));

app.get("/api/activity/overview", asyncRoute(async (req, res) => {
  res.json(await getActivityOverview(config, req.query.rangeHours));
}));

app.get("/api/activity/topics", asyncRoute(async (req, res) => {
  res.json({ topics: await getActivityTopics(config, req.query) });
}));

app.get("/api/activity/active-now", asyncRoute(async (_req, res) => {
  res.json({ topics: await getActiveNow(config) });
}));

app.get("/api/activity/members", asyncRoute(async (req, res) => {
  res.json(await getMemberVisits(config, req.query.rangeHours));
}));

app.get("/api/ifsqn/growth", asyncRoute(async (req, res) => {
  res.json(await getIfsqnGrowth(config, req.query.rangeDays));
}));

app.get("/api/search", asyncRoute(async (req, res) => {
  res.json(await searchPosts(config, parseSearchInput(req.query)));
}));

app.get("/api/topics/:corpus/:topicId", asyncRoute(async (req, res) => {
  const corpus = req.params.corpus === "elsmar" ? "elsmar" : "ifsqn";
  const topicId = Number(req.params.topicId);
  if (!Number.isInteger(topicId) || topicId < 1) {
    res.status(400).json({ error: "topicId must be a positive integer" });
    return;
  }
  res.json(await getTopic(config, corpus, topicId));
}));

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: message });
});

app.listen(config.PORT, config.HOST, () => {
  process.stdout.write(`food-forum-dashboard listening on http://${config.HOST}:${config.PORT}\n`);
});
