/**
 * authenticate.ts — backwards-compatibility re-export shim.
 *
 * The canonical implementation now lives in `./auth.ts`.
 * This file is kept so existing imports in route files continue to resolve
 * without modification.
 *
 * New code should import directly from `./auth`:
 *   import { authenticate, authorize } from "../middleware/auth";
 */
export {
  authenticate,
  authorize,
  type AuthPayload,
  type AuthenticatedRequest,
} from "./auth";
