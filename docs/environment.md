# Environment Variables

All environment variables for the API server. Copy `server/.env.example` to
`server/.env` and fill in your values before starting.

---

## Required Variables

The server **will not start** if any of these are missing:

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret key used to sign and verify JWTs. Use a random string of at least 32 characters. |
| `DATABASE_URL` | PostgreSQL connection string. |
| `ESCROW_CONTRACT_ADDRESS` | Deployed Soroban escrow contract ID (starts with `C`). |
| `PLATFORM_TREASURY_USER_ID` | User ID that receives platform fees. |

---

## Full Reference

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Port the Express server listens on. |
| `NODE_ENV` | `development` | Set to `production` in deployed environments. Affects morgan log format and other behaviour. |
| `CORS_ORIGIN` | `*` | Allowed CORS origin. Set to your frontend URL in production, e.g. `https://airflex.app`. |
| `PLATFORM_FEE_PERCENT` | `1.5` | Percentage deducted from each completed trade. |
| `RELEASE_RETRY_MAX` | `3` | Maximum number of delivery verification retry attempts before escalating to Disputed. |
| `RELEASE_RETRY_BASE_DELAY_MS` | `2000` | Base delay in milliseconds for exponential backoff and retry jitter. |

### Database

| Variable | Example | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://user:pass@localhost:5432/airflex` | Full PostgreSQL connection string including credentials and database name. |

### Stellar

| Variable | Example | Description |
|----------|---------|-------------|
| `STELLAR_NETWORK` | `testnet` | Set to `mainnet` to use the public Stellar network. Any other value uses testnet. |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon REST API endpoint for account loading and transaction submission. |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint for contract simulation and invocation. |
| `ESCROW_CONTRACT_ADDRESS` | `CCBJ235OC...` | Contract ID of the deployed AirFlex escrow contract. |

**Mainnet endpoints:**
```
HORIZON_URL=https://horizon.stellar.org
SOROBAN_RPC_URL=https://mainnet.stellar.validationcloud.io/v1/<API_KEY>
```

### Payments

| Variable | Example | Description |
|----------|---------|-------------|
| `PAYSTACK_SECRET_KEY` | `sk_test_xxx` | Paystack secret key for fiat deposit and withdrawal processing. Use `sk_test_` prefix for test mode, `sk_live_` for production. |

### Messaging

| Variable | Example | Description |
|----------|---------|-------------|
| `TERMII_API_KEY` | `TLxxx` | Termii API key for OTP delivery via SMS. |

### Auth

| Variable | Example | Description |
|----------|---------|-------------|
| `JWT_SECRET` | `a_long_random_string` | Must be at least 32 characters. Never commit this value. Rotate it to invalidate all existing sessions. |

---

## Example `.env`

```env
# Server
PORT=3001
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000

# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/airflex

# Stellar
STELLAR_NETWORK=testnet
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
ESCROW_CONTRACT_ADDRESS=CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP

# Payments
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Messaging
TERMII_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Auth
JWT_SECRET=change_me_to_a_long_random_string_at_least_32_chars
```

---

## Security Notes

- Never commit `.env` to version control. It is listed in `.gitignore`.
- `JWT_SECRET` rotation invalidates all active sessions — plan for re-login.
- `stellar_secret_key` values stored in the `wallets` table should be encrypted
  at rest using envelope encryption (e.g. AWS KMS) before production launch.
- Set `CORS_ORIGIN` to your exact frontend domain in production — never leave
  it as `*` in a live environment.
