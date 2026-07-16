import mongoose from "mongoose";

// Read-only subset of velte-backend's models/Wallet.model.js, pointed at the
// same "wallets" collection. This service NEVER creates or mutates a wallet
// — velte-backend is the sole owner of wallet creation (incl. the starter-
// credit grant) and all balance mutations. A vendor with no wallet row yet
// is simply treated as balanceKobo === 0 (ineligible for search) by the
// caller, rather than this model lazily provisioning one — see
// retrieval.service.js's filterWalletEligible. velte-backend provisions the
// wallet proactively at store-creation time (store.controller.js's
// getOrCreateStore) specifically so a vendor is never left uncreated by the
// time their listings could appear in search.
const walletReadSchema = new mongoose.Schema(
  {
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    balanceKobo: { type: Number },
  },
  { collection: "wallets", strict: false },
);

export default mongoose.model("WalletRead", walletReadSchema);
