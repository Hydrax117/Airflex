import { Router, Request, Response, NextFunction } from "express";
import pool from "../db";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { getWalletBalance } from "../services/stellar";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ---------------------------------------------------------------------------
// GET /api/wallet  (authenticated)
// ---------------------------------------------------------------------------

/**
 * Returns the authenticated user's Stellar public key and current XLM balance.
 * The secret key is never included in the response.
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const { sub: userId } = (req as AuthenticatedRequest).user;

    const { rows } = await pool.query<{ stellar_public_key: string }>(
      `SELECT stellar_public_key FROM wallets WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (!rows.length || !rows[0]?.stellar_public_key) {
      res.status(404).json({
        error: "Wallet not found. It may still be provisioning — try again shortly.",
      });
      return;
    }

    const publicKey = rows[0].stellar_public_key;

    let balance: string;
    try {
      balance = await getWalletBalance(publicKey);
    } catch (err) {
      console.error("[wallet] Failed to fetch balance for", publicKey, "–", (err as Error).message);
      res.status(502).json({ error: "Unable to fetch balance from Horizon. Try again." });
      return;
    }

    res.status(200).json({
      publicKey,
      balance,          // XLM balance as a decimal string, e.g. "10000.0000000"
      asset: "XLM",
      network: process.env["STELLAR_NETWORK"] ?? "testnet",
    });
  })
);

export default router;
