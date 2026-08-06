import { Router, Request, Response, NextFunction } from "express";
import pool from "../db";
import { authenticate, authorize } from "../middleware/auth";
import type { TradeOffer } from "../types/trade";

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

// All admin routes require a valid JWT **and** the "admin" role.
// authenticate verifies the token; authorize("admin") checks req.user.role.
router.use(authenticate, authorize("admin"));

// ---------------------------------------------------------------------------
// GET /api/admin/trades
// Returns all trade offers regardless of status (admin view).
// ---------------------------------------------------------------------------

router.get(
  "/trades",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query<TradeOffer>(
      `SELECT * FROM trade_offers ORDER BY created_at DESC LIMIT 200`
    );
    res.status(200).json({ data: rows });
  })
);

// ---------------------------------------------------------------------------
// GET /api/admin/users/:id
// Returns a single user record by ID for admin lookup.
// The stellar_secret_key is explicitly excluded from the response.
// ---------------------------------------------------------------------------

router.get(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows } = await pool.query<{
      id: string;
      phone: string;
      role: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, phone, role, created_at, updated_at
       FROM users
       WHERE id = $1`,
      [id]
    );

    if (!rows.length) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.status(200).json({ data: rows[0] });
  })
);

// ---------------------------------------------------------------------------
// PATCH /api/admin/trades/:id/release
// Admin releases escrow payment to seller after confirmed delivery.
// (Business logic delegated to the Stellar service layer — stub here.)
// ---------------------------------------------------------------------------

router.patch(
  "/trades/:id/release",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows } = await pool.query<TradeOffer>(
      `UPDATE trade_offers
       SET status = 'Completed', updated_at = NOW()
       WHERE id = $1 AND status = 'Locked'
       RETURNING *`,
      [id]
    );

    if (!rows.length) {
      res.status(404).json({
        error: "Trade not found or not in Locked state",
      });
      return;
    }

    res.status(200).json({ data: rows[0] });
  })
);

export default router;
