import { Request, Response, NextFunction } from "express";
import jwt, { TokenExpiredError } from "jsonwebtoken";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decoded JWT payload attached to every authenticated request.
 *
 * `role` defaults to "user" when not present in older tokens so the field is
 * always safe to read without a null-check.
 */
export interface AuthPayload {
  /** User ID (UUID) — maps to `users.id` in the database */
  sub: string;
  /** Stellar public key (G…) of the user's wallet */
  stellarPublicKey: string;
  /**
   * Role assigned at token issuance.
   * Allowed values: "user" | "admin"
   * Defaults to "user" when the claim is absent (legacy token compatibility).
   */
  role: string;
}

/** Express Request extended with the verified JWT payload */
export interface AuthenticatedRequest extends Request {
  user: AuthPayload;
}

// ---------------------------------------------------------------------------
// authenticate
// ---------------------------------------------------------------------------

/**
 * Verifies the `Authorization: Bearer <token>` header.
 *
 * Attaches the decoded payload to `req.user` on success and calls `next()`.
 *
 * Error responses:
 *   401 { "error": "Unauthorized" }         — header missing or malformed
 *   401 { "error": "Token expired" }        — valid signature, but past exp
 *   401 { "error": "Unauthorized" }         — invalid signature / other error
 *
 * Expired tokens get a distinct message so clients can prompt re-authentication
 * without treating expiry the same as a tampered token.
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers["authorization"];

  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = header.slice(7).trim();

  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const secret = process.env["JWT_SECRET"];

  if (!secret) {
    // Fail closed — never allow requests through if the secret is missing
    console.error("[auth] JWT_SECRET is not set");
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as AuthPayload;

    // Normalise the role — older tokens issued without a role default to "user"
    if (!payload.role) {
      payload.role = "user";
    }

    (req as AuthenticatedRequest).user = payload;
    next();
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      res.status(401).json({ error: "Token expired" });
      return;
    }
    // Covers NotBeforeError, JsonWebTokenError (bad signature, malformed, etc.)
    res.status(401).json({ error: "Unauthorized" });
  }
}

// ---------------------------------------------------------------------------
// authorize
// ---------------------------------------------------------------------------

/**
 * Role-based authorization middleware factory.
 *
 * Must be placed **after** `authenticate` in the middleware chain because it
 * reads `req.user.role` which `authenticate` attaches.
 *
 * Usage:
 *   router.delete("/user/:id", authenticate, authorize("admin"), handler)
 *   router.get("/dashboard",   authenticate, authorize("admin", "staff"), handler)
 *
 * Error responses:
 *   403 { "error": "Forbidden" }  — authenticated but insufficient role
 *
 * @param roles  One or more roles that are permitted to access the route.
 *               Role comparison is case-insensitive.
 */
export function authorize(...roles: string[]) {
  const normalised = roles.map((r) => r.toLowerCase());

  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;

    // Guard: authenticate must run before authorize
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!normalised.includes(user.role.toLowerCase())) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}
