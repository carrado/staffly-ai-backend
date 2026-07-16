// Voyage AI client — embeddings + reranking for Velte Connect retrieval
// (Velte_Connect_Technical_Implementation.md §6). Plain fetch, no SDK.
//
// Duplicated verbatim from velte-backend/src/services/voyage.service.js
// (which keeps its own copy for write-time embedding on product/store
// create/update — see that repo's embedding.service.js). This is a thin,
// self-contained third-party API wrapper with no business logic and no
// cross-model dependencies, so duplicating it is low-risk compared to
// duplicating actual ranking/matching logic — see this repo's README.

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";
const VOYAGE_MULTIMODAL_URL = "https://api.voyageai.com/v1/multimodalembeddings";
const EMBED_MODEL = "voyage-4";
const RERANK_MODEL = "rerank-2.5";
const MULTIMODAL_MODEL = "voyage-multimodal-3";
const TIMEOUT_MS = 15_000;

const MAX_RETRIES = 1;
const RETRY_DELAYS_MS = [250];

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(makeRequest, label, deadlineAt) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const remainingMs =
      deadlineAt == null ? TIMEOUT_MS : deadlineAt - Date.now();
    if (remainingMs <= 0) {
      console.error(`[voyage] ${label} skipped — search deadline already spent`);
      throw lastErr ?? new Error(`${label}: search deadline exceeded`);
    }

    try {
      const res = await makeRequest(Math.min(TIMEOUT_MS, remainingMs));
      if (res.ok || !isRetryableStatus(res.status) || attempt === MAX_RETRIES) {
        return res;
      }
      console.error(
        `[voyage] ${label} got ${res.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES})…`,
      );
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      lastErr = err;
      console.error(
        `[voyage] ${label} network error, retrying (attempt ${attempt + 1}/${MAX_RETRIES}):`,
        err.message,
      );
    }

    const backoff = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1);
    const budgetLeft =
      deadlineAt == null ? backoff : Math.max(0, deadlineAt - Date.now());
    await sleep(Math.min(backoff, budgetLeft));
  }
  throw lastErr;
}

/**
 * Embed one or more texts. `inputType` is "document" for catalog data,
 * "query" for a buyer's search text. Returns null (not a throw) if the key
 * is missing or the call fails. `deadlineAt` — optional Date.now()-scale
 * timestamp shared across every Voyage call within one buyer search.
 */
export async function embed(texts, inputType, deadlineAt) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !texts?.length) return null;

  try {
    const res = await fetchWithRetry(
      (timeoutMs) =>
        fetch(VOYAGE_EMBEDDINGS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: EMBED_MODEL,
            input: texts,
            input_type: inputType,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      "embed",
      deadlineAt,
    );

    if (!res.ok) {
      console.error(`[voyage] embed failed: ${res.status} ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    const vectors = data?.data?.map((d) => d.embedding);
    return Array.isArray(vectors) && vectors.every(Array.isArray)
      ? vectors
      : null;
  } catch (err) {
    console.error("[voyage] embed error:", err.message);
    return null;
  }
}

/**
 * Embed a single image (optionally paired with text) via voyage-multimodal-3.
 * Same never-throw convention as embed/rerank.
 */
export async function embedImage(imageUrl, inputType, text, deadlineAt) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !imageUrl) return null;

  try {
    const content = [];
    if (text) content.push({ type: "text", text });
    content.push({ type: "image_url", image_url: imageUrl });

    const res = await fetchWithRetry(
      (timeoutMs) =>
        fetch(VOYAGE_MULTIMODAL_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: MULTIMODAL_MODEL,
            inputs: [{ content }],
            input_type: inputType,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      "embedImage",
      deadlineAt,
    );

    if (!res.ok) {
      console.error(
        `[voyage] embedImage failed: ${res.status} ${await res.text()}`,
      );
      return null;
    }

    const data = await res.json();
    const vector = data?.data?.[0]?.embedding;
    return Array.isArray(vector) ? vector : null;
  } catch (err) {
    console.error("[voyage] embedImage error:", err.message);
    return null;
  }
}

/**
 * Rerank `documents` against `query`, returning a relevance score per
 * document in the SAME order as the input array. Returns null on any
 * failure so callers can fall back to vector-search order alone.
 */
export async function rerank(query, documents, deadlineAt) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || !documents?.length) return null;

  try {
    const res = await fetchWithRetry(
      (timeoutMs) =>
        fetch(VOYAGE_RERANK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: RERANK_MODEL,
            query,
            documents,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      "rerank",
      deadlineAt,
    );

    if (!res.ok) {
      console.error(`[voyage] rerank failed: ${res.status} ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    // Voyage's rerank envelope is { object, data: [{index, relevance_score}],
    // model, usage } — NOT { results: [...] }.
    const results = data?.data;
    if (!Array.isArray(results)) {
      console.error("[voyage] rerank response missing data[] array:", JSON.stringify(data));
      return null;
    }

    const scores = new Array(documents.length).fill(0);
    for (const r of results) {
      if (typeof r.index === "number" && typeof r.relevance_score === "number") {
        scores[r.index] = r.relevance_score;
      }
    }
    return scores;
  } catch (err) {
    console.error("[voyage] rerank error:", err.message);
    return null;
  }
}
