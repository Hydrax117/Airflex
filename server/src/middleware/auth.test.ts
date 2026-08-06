/**
 * auth.test.ts
 *
 * Unit tests for authenticate() and authorize() middleware.
 * Uses inline Express apps + Supertest — no database, no Stellar SDK calls.
 * Real JWTs are signed with a test secret to exercise the full jwt.verify path.
 */

import express, { Request, Response } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { authenticate, authorize, type AuthenticatedRequest } from "./auth";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-secret-at-least-32-characters-long!!";

/** Build a signed JWT for the given payload using the test secret */
function signToken(
  payload: object,
  options: jwt.SignOptions = { expiresIn: "1h" }
): string {
  return jwt.sign(payload, TEST_SECRET, options);
}

const userPayload = {
  sub: "user-uuid-1234",
  stellarPublicKey: "GABCDEFG",
  role: "user",
};

const adminPayload = {
  sub: "admin-uuid-5678",
  stellarPublicKey: "GADMINKEY",
  role: "admin",
};

/** Build a minimal app that exposes /protected using the given middleware chain */
function makeApp(...middlewares: express.RequestHandler[]) {
  const app = express();
  app.use(express.json());

  // Set JWT_SECRET for all tests
  process.env["JWT_SECRET"] = TEST_SECRET;

  app.get(
    "/protected",
    ...middlewares,
    (req: Request, res: Response) => {
      const user = (req as AuthenticatedRequest).user;
      res.status(200).json({ ok: true, user });
    }
  );
  return app;
}

// ---------------------------------------------------------------------------
// authenticate — success
// ---------------------------------------------------------------------------

describe("authenticate — valid token", () => {
  it("returns 200 and attaches req.user for a valid token", async () => {
    const token = signToken(userPayload);
    const res = await request(makeApp(authenticate))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.sub).toBe(userPayload.sub);
    expect(res.body.user.role).toBe("user");
  });

  it("defaults role to 'user' when the JWT has no role claim", async () => {
    // Legacy token — no role field
    const token = signToken({ sub: "old-user", stellarPublicKey: "GKEY" });
    const res = await request(makeApp(authenticate))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("user");
  });

  it("attaches the full payload including stellarPublicKey", async () => {
    const token = signToken(adminPayload);
    const res = await request(makeApp(authenticate))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.stellarPublicKey).toBe(adminPayload.stellarPublicKey);
  });
});

// ---------------------------------------------------------------------------
// authenticate — missing / malformed header
// ---------------------------------------------------------------------------

describe("authenticate — missing or malformed header", () => {
  it("returns 401 { error: 'Unauthorized' } when no Authorization header", async () => {
    const res = await request(makeApp(authenticate)).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 when Authorization header does not start with 'Bearer '", async () => {
    const res = await request(makeApp(authenticate))
      .get("/protected")
      .set("Authorization", "Basic dXNlcjpwYXNz");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 when the token is an empty string after 'Bearer '", async () => {
    const res = await request(makeApp(authenticate))
      .get("/protected")
      .set("Authorization", "Bearer ");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 for a malformed (non-JWT) token string", async () => {
    const res = await request(makeApp(authenticate))
      .get("/protected")
      .set("Authorization", "Bearer this.is.not.a.jwt");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 401 for a token signed with the wrong secret", async () => {
    const token = jwt.sign(userPayload, "wrong-secret");
    const res = await request(makeApp(authenticate))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });
});

// ---------------------------------------------------------------------------
// authenticate — token expiry
// ---------------------------------------------------------------------------

describe("authenticate — expired token", () => {
  it("returns 401 { error: 'Token expired' } for an expired token", async () => {
    // Sign a token that expired 10 seconds ago
    const token = signToken(userPayload, { expiresIn: -10 });
    const res = await request(makeApp(authenticate))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Token expired");
  });

  it("distinguishes 'Token expired' from generic 'Unauthorized'", async () => {
    const expiredToken = signToken(userPayload, { expiresIn: -1 });
    const badToken = jwt.sign(userPayload, "wrong");

    const [expiredRes, badRes] = await Promise.all([
      request(makeApp(authenticate))
        .get("/protected")
        .set("Authorization", `Bearer ${expiredToken}`),
      request(makeApp(authenticate))
        .get("/protected")
        .set("Authorization", `Bearer ${badToken}`),
    ]);

    expect(expiredRes.body.error).toBe("Token expired");
    expect(badRes.body.error).toBe("Unauthorized");
    // Both return 401 — but distinct messages
    expect(expiredRes.status).toBe(401);
    expect(badRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// authorize — success
// ---------------------------------------------------------------------------

describe("authorize — permitted role", () => {
  it("calls next() when the user role matches the required role", async () => {
    const token = signToken(adminPayload);
    const res = await request(makeApp(authenticate, authorize("admin")))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("is case-insensitive for role comparison", async () => {
    const token = signToken({ ...adminPayload, role: "ADMIN" });
    const res = await request(makeApp(authenticate, authorize("admin")))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("accepts multiple allowed roles and grants access if any match", async () => {
    const token = signToken(userPayload); // role: "user"
    const res = await request(
      makeApp(authenticate, authorize("admin", "user"))
    )
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// authorize — forbidden
// ---------------------------------------------------------------------------

describe("authorize — insufficient role", () => {
  it("returns 403 { error: 'Forbidden' } when role does not match", async () => {
    const token = signToken(userPayload); // role: "user", requires "admin"
    const res = await request(makeApp(authenticate, authorize("admin")))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });

  it("returns 403 when no role is in the allowed list", async () => {
    const token = signToken({ ...userPayload, role: "staff" });
    const res = await request(makeApp(authenticate, authorize("admin")))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });

  it("returns 403 not 401 — authenticated but not authorised", async () => {
    const token = signToken(userPayload);
    const res = await request(makeApp(authenticate, authorize("admin")))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    // Must be 403 (Forbidden), not 401 (Unauthorised)
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("returns 401 when authorize is called without prior authenticate", async () => {
    // authorize alone — req.user is undefined
    const app = express();
    app.use(express.json());
    process.env["JWT_SECRET"] = TEST_SECRET;
    app.get("/protected", authorize("admin"), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });
});

// ---------------------------------------------------------------------------
// Integration — authenticate then authorize in a full middleware chain
// ---------------------------------------------------------------------------

describe("authenticate + authorize — full chain", () => {
  it("allows admin through both gates", async () => {
    const token = signToken(adminPayload);
    const res = await request(makeApp(authenticate, authorize("admin")))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("admin");
  });

  it("blocks an expired admin token with 401 before reaching authorize", async () => {
    const token = signToken(adminPayload, { expiresIn: -1 });
    const res = await request(makeApp(authenticate, authorize("admin")))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Token expired");
  });

  it("blocks a valid user token on an admin-only route with 403", async () => {
    const token = signToken(userPayload);
    const res = await request(makeApp(authenticate, authorize("admin")))
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });
});
