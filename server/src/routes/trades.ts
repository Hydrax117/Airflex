import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import pool from "../db";
import { authenticate, AuthenticatedRequest } from "../middleware/authenticate";
import { validate } from "../middleware/validate";
import { createListing, depositToEscrow } from "../services/stellar";
import {
  triggerVerification,
  VerificationError,
} from "../services/tradeVerification";
import { NotificationService } from "../services/notifications";
import { asyncHandler } from "../utils/asyncHandler";
import type { TradeOffer } from "../types/trade";
import {
  createTradeSchema,
  buyTradeSchema,
  paginationSchema,
  createRatingSchema,
  type CreateTradeInput,
  type BuyTradeInput,
  type CreateRatingInput,
} from "../schemas";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/v1/trades
// ---------------------------------------------------------------------------

router.get(
  "/",
  async (req, res) => {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    // Join ratings on reviewee_display_id so the count survives account
    // anonymisation (issue #362).  The display_id is captured at rating
    // creation time and is never modified by the anonymisation job, unlike
    // the raw UUID which becomes a dangling reference once PII is scrubbed.
    const { rows: trades } = await pool.query<
      TradeOffer & { seller_average_rating: number; seller_review_count: number }
    >(
      `SELECT t.*,
              COALESCE(sr.avg_stars, 0)::float8 AS seller_average_rating,
              COALESCE(sr.review_count, 0)::int AS seller_review_count
       FROM trade_offers t
       LEFT JOIN LATERAL (
         SELECT AVG(stars)::numeric(4,2) AS avg_stars, COUNT(*)::int AS review_count
         FROM ratings
         WHERE reviewee_display_id = t.seller_id::text
       ) sr ON TRUE
       WHERE t.status = 'Active' AND t.expires_at > NOW()
       ORDER BY t.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM trade_offers
       WHERE status = 'Active' AND expires_at > NOW()`
    );

    const total = parseInt(countRows[0]?.count ?? "0", 10);

    res.status(200).json({
      data: trades,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/trades  (authenticated)
// ---------------------------------------------------------------------------

router.post(
  "/",
  authenticate,
  validate(createTradeSchema),
  async (req, res) => {
    const { assetType, amount, expiresInHours } = req.body as CreateTradeInput;
    const { sub: sellerId, stellarPublicKey } = (req as unknown as AuthenticatedRequest).user;

    // Fetch seller's encrypted secret key from their wallet record
    const { rows: walletRows } = await pool.query<{
      stellar_secret_key: string;
    }>(
      `SELECT stellar_secret_key FROM wallets WHERE user_id = $1 LIMIT 1`,
      [sellerId]
    );

    if (!walletRows.length || !walletRows[0]?.stellar_secret_key) {
      res.status(400).json({ error: "Seller wallet not found" });
      return;
    }

    const expiresAt = new Date(
      Date.now() + expiresInHours * 60 * 60 * 1000
    );

    // Call Soroban create_listing — may throw if contract call fails
    const contractListingId = await createListing({
      sellerPublicKey: stellarPublicKey,
      sellerSecretKey: walletRows[0].stellar_secret_key,
      assetType,
      amount,
      expiresAt,
    });

    const tradeId = uuidv4();

    const { rows } = await pool.query<TradeOffer>(
      `INSERT INTO trade_offers
         (id, seller_id, asset_type, amount, status, contract_listing_id, expires_at)
       VALUES ($1, $2, $3, $4, 'Active', $5, $6)
       RETURNING *`,
      [tradeId, sellerId, assetType, amount, contractListingId, expiresAt]
    );

    res.status(201).json({ data: rows[0] });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/trades/:id
// ---------------------------------------------------------------------------

router.get(
  "/:id",
  async (req, res) => {
    const { id } = req.params;

    const { rows } = await pool.query<TradeOffer>(
      `SELECT *, fee_amount AS "feeAmount", seller_net_amount AS "sellerNetAmount"
         FROM trade_offers WHERE id = $1`,
      [id]
    );

    if (!rows.length) {
      res.status(404).json({ error: "Trade offer not found" });
      return;
    }

    res.status(200).json({ data: rows[0] });
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/trades/:id/buy  (authenticated)
// ---------------------------------------------------------------------------

router.post(
  "/:id/buy",
  authenticate,
  validate(buyTradeSchema),
  async (req, res) => {
    const { id } = req.params;
    const { sub: buyerId, stellarPublicKey } = (req as unknown as AuthenticatedRequest).user;
    const { buyerSecretKey } = req.body as BuyTradeInput;

    // Load the trade offer
    const { rows: tradeRows } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers WHERE id = $1`,
      [id]
    );

    if (!tradeRows.length) {
      res.status(404).json({ error: "Trade offer not found" });
      return;
    }

    const trade = tradeRows[0]!;

    if (trade.status !== "Active") {
      res.status(400).json({
        error: `Trade is not available for purchase (status: ${trade.status})`,
      });
      return;
    }

    if (!trade.contract_listing_id) {
      res.status(400).json({ error: "Trade has no associated contract listing" });
      return;
    }

    if (trade.seller_id === buyerId) {
      res.status(400).json({ error: "Seller cannot buy their own trade" });
      return;
    }

    // Call Soroban deposit_to_escrow
    const txHash = await depositToEscrow({
      buyerPublicKey: stellarPublicKey,
      buyerSecretKey: buyerSecretKey,
      listingId: trade.contract_listing_id,
      amount: trade.amount,
    });

    // Lock the trade in the database
    const { rows: updated } = await pool.query<TradeOffer>(
      `UPDATE trade_offers
       SET status = 'Locked', buyer_id = $1, escrow_tx_hash = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [buyerId, txHash, id]
    );

    // Notify the seller that their trade has been locked (best-effort)
    void NotificationService.send(trade.seller_id, "TRADE_LOCKED", {
      tradeId: id,
    });

    res.status(200).json({ data: updated[0] });
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/trades/:id/confirm-delivery  (authenticated — seller only)
// ---------------------------------------------------------------------------

/**
 * Seller calls this endpoint to signal that they have delivered the
 * airtime / data and the escrow payment should be released.
 *
 * The endpoint responds with 202 Accepted immediately. Verification and the
 * Soroban `release_payment` call run asynchronously in the background so the
 * seller's request never times out waiting for on-chain confirmation.
 *
 * Flow:
 *  1. Authenticate + validate trade ownership synchronously.
 *  2. Return 202 to the seller.
 *  3. tradeVerification.triggerVerification() runs in the background:
 *       - Calls release_payment on the escrow contract (up to 3 attempts).
 *       - On success: updates DB to Completed, notifies parties via SSE.
 *       - On failure: escalates to Disputed, fires SSE admin alert.
 */
router.post(
  "/:id/confirm-delivery",
  authenticate,
  async (req, res) => {
    const { id } = req.params;
    const { sub: sellerId } = (req as unknown as AuthenticatedRequest).user;

    try {
      // triggerVerification validates synchronously then fires async work
      await triggerVerification(id, sellerId);
    } catch (err) {
      if (err instanceof VerificationError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      throw err; // Re-throw unexpected errors to global handler
    }

    res.status(202).json({
      message:
        "Delivery confirmation received. Payment release is being processed — " +
        "you will be notified via the event stream when complete.",
      tradeId: id,
    });
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/trades/:id/dispute  (authenticated — buyer or seller)
// ---------------------------------------------------------------------------

/**
 * Escalate a locked trade to Disputed status.
 * Both the buyer and seller of a locked trade have permission to dispute.
 */
router.post(
  "/:id/dispute",
  authenticate,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { sub: userId } = (req as unknown as AuthenticatedRequest).user;
    const { reason } = (req.body ?? {}) as { reason?: string };

    if (!reason || typeof reason !== "string" || !reason.trim()) {
      res.status(400).json({ error: "Dispute reason is required" });
      return;
    }

    if (reason.trim().length > 500) {
      res.status(400).json({ error: "Dispute reason cannot exceed 500 characters" });
      return;
    }

    // Fetch the trade offer
    const { rows: tradeRows } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers WHERE id = $1`,
      [id]
    );

    if (!tradeRows.length) {
      res.status(404).json({ error: "Trade offer not found" });
      return;
    }

    const trade = tradeRows[0]!;

    // Viewer must be buyer or seller
    if (trade.seller_id !== userId && trade.buyer_id !== userId) {
      res.status(403).json({ error: "Only the buyer or seller can dispute this trade" });
      return;
    }

    if (trade.status === "Disputed") {
      res.status(409).json({ error: "Trade is already disputed" });
      return;
    }

    if (trade.status !== "Locked") {
      res.status(400).json({
        error: `Only locked trades can be disputed (current status: ${trade.status})`,
      });
      return;
    }

    // Transition trade to Disputed
    const { rows: updated } = await pool.query<TradeOffer>(
      `UPDATE trade_offers
       SET status = 'Disputed', updated_at = NOW()
       WHERE id = $1 AND status = 'Locked'
       RETURNING *`,
      [id]
    );

    if (!updated.length) {
      res.status(409).json({ error: "Trade is no longer in a locked state" });
      return;
    }

    // Notify participants and admins
    const participants = [trade.seller_id, trade.buyer_id].filter(Boolean) as string[];
    void NotificationService.sendToMany(participants, "DISPUTE_FILED", {
      tradeId: id,
      reason: reason.trim(),
    });
    void NotificationService.sendToAdmins("DISPUTE_FILED", {
      tradeId: id,
      reason: reason.trim(),
    });

    res.status(200).json({
      message: "Trade successfully disputed. An admin will review within 24 hours.",
      data: updated[0],
    });
  })
);

router.post(
  "/:id/rate",
  authenticate,
  validate(createRatingSchema),
  asyncHandler(async (req, res) => {
    const tradeId = req.params["id"];
    const { stars, comment } = req.body as CreateRatingInput;
    const { sub: reviewerId } = (req as AuthenticatedRequest).user;

    const { rows: trades } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers WHERE id = $1 LIMIT 1`,
      [tradeId]
    );

    if (!trades.length) {
      res.status(404).json({ error: "Trade not found" });
      return;
    }

    const trade = trades[0]!;

    if (trade.status !== "Completed") {
      res.status(400).json({ error: "Only completed trades can be rated" });
      return;
    }

    if (trade.buyer_id !== reviewerId) {
      res.status(403).json({ error: "Only the buyer can rate this trade" });
      return;
    }

    // Resolve the seller's stable display identifier at rating creation time.
    // We capture it now so the rating remains retrievable even after the
    // seller's account is anonymised and their phone is replaced with a hash
    // (issue #362).  The display_id is the seller's phone (or the anonymised
    // hash if the account has already been scrubbed) — it never changes after
    // it is written here, giving the LATERAL join in GET /trades a stable key.
    const { rows: sellerRows } = await pool.query<{ phone: string }>(
      `SELECT phone FROM users WHERE id = $1 LIMIT 1`,
      [trade.seller_id]
    );

    // Fall back to the raw UUID text if the seller row has somehow been
    // removed — this should not happen due to FK CASCADE, but guards against
    // a split-second race between deletion and rating.
    const revieweeDisplayId =
      sellerRows[0]?.phone?.trim() || trade.seller_id;

    try {
      const { rows } = await pool.query(
        `INSERT INTO ratings (trade_id, reviewer_id, reviewee_id, reviewee_display_id, stars, comment)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [tradeId, reviewerId, trade.seller_id, revieweeDisplayId, stars, comment ?? null]
      );

      res.status(201).json({ data: rows[0] });
    } catch (err: unknown) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === "23505") {
        res.status(409).json({ error: "This trade has already been rated" });
        return;
      }
      throw err;
    }
  })
);

export default router;
