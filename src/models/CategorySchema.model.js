import mongoose from "mongoose";

// Phase 2 of the frontend repo's docs/velte-ai-search-flow-plan.md: the
// DB-backed half of the category/service attribute schemas that drive the
// buyer-facing clarifying questions (velte's sectorClarifiers.ts). This is
// an OVERRIDES layer, not a migration: the collection starts empty and the
// frontend's in-code presets (attribute-presets.ts) remain the complete
// fallback — a document here wins over the in-code group with the same
// (kind, key), so a category's questions can be tuned without a deploy,
// and deleting the document reverts to the shipped defaults.
//
// kind/key address the three in-code tables:
//   service_group    / <group name>   → one SERVICE_DETAIL_PRESETS group
//                                       (e.g. "Phone & Gadget Repairs",
//                                       "General")
//   product_category / <category id>  → PRODUCT_PRESETS_BY_CATEGORY[key]
//                                       (e.g. "electronics", "fashion")
//   product_general  / "general"      → GENERAL_PRODUCT_PRESETS
//
// `items` mirrors the frontend's AttributePreset shape. `important` marks
// the fields the clarifier asks about first (selectClarifierFields'
// prioritizeImportant) — flipping it here retunes question priority live.

const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    example: { type: String, default: null },
    important: { type: Boolean, default: false },
  },
  { _id: false },
);

const categorySchemaSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["service_group", "product_category", "product_general"],
      required: true,
    },
    key: { type: String, required: true },
    items: { type: [itemSchema], default: [] },
  },
  { timestamps: true },
);

categorySchemaSchema.index({ kind: 1, key: 1 }, { unique: true });

export default mongoose.model("CategorySchema", categorySchemaSchema);
