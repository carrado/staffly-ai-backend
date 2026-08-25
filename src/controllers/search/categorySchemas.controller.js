import { AppError } from "../../middleware/errorHandler.js";
import CategorySchema from "../../models/CategorySchema.model.js";

// See CategorySchema.model.js's own comment for what this collection is
// (the DB-backed overrides layer for clarifying-question schemas, Phase 2
// of the frontend's docs/velte-ai-search-flow-plan.md).

const VALID_KINDS = ["service_group", "product_category", "product_general"];

// ── GET /api/search/category-schemas ──────────────────────────────────────
// Public (same trust model as the other /api/search reads) — the whole
// collection, which is small by construction (a few dozen docs at most).
// The frontend caches this in-memory with a short TTL; freshness within
// minutes is the contract, not per-request reads.
export async function listCategorySchemas(req, res, next) {
  try {
    const rows = await CategorySchema.find({}, "kind key items -_id").lean();
    res.json({ success: true, data: { schemas: rows } });
  } catch (err) {
    next(err);
  }
}

// ── PUT /api/internal/category-schemas (internal-secret guarded) ──────────
// Upsert one override. No public write path exists on purpose — edits come
// from an operator (curl/script, later the super-admin panel), never from
// buyers or vendors.
export async function upsertCategorySchema(req, res, next) {
  try {
    const { kind, key, items } = req.body ?? {};
    if (!VALID_KINDS.includes(kind)) {
      throw new AppError(`kind must be one of: ${VALID_KINDS.join(", ")}.`, 400);
    }
    if (typeof key !== "string" || !key.trim()) {
      throw new AppError("key is required.", 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(
        "items must be a non-empty array — delete the document instead to revert to the in-code defaults.",
        400,
      );
    }
    const cleaned = items.map((item) => {
      if (!item || typeof item.name !== "string" || !item.name.trim()) {
        throw new AppError("Every item needs a non-empty name.", 400);
      }
      return {
        name: item.name.trim(),
        example: typeof item.example === "string" ? item.example : null,
        important: Boolean(item.important),
      };
    });

    const row = await CategorySchema.findOneAndUpdate(
      { kind, key: key.trim() },
      { $set: { items: cleaned } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    res.json({
      success: true,
      data: { kind: row.kind, key: row.key, items: row.items },
    });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /api/internal/category-schemas (internal-secret guarded) ───────
// Removing an override reverts that (kind, key) to the frontend's shipped
// in-code preset — the safe rollback for a bad edit.
export async function deleteCategorySchema(req, res, next) {
  try {
    const { kind, key } = req.body ?? {};
    if (!VALID_KINDS.includes(kind) || typeof key !== "string" || !key.trim()) {
      throw new AppError("kind and key are required.", 400);
    }
    const result = await CategorySchema.deleteOne({ kind, key: key.trim() });
    if (result.deletedCount === 0) {
      throw new AppError("No override exists for that kind/key.", 404);
    }
    res.json({ success: true, message: "Override removed." });
  } catch (err) {
    next(err);
  }
}
