# Pipe Pilot API — Stripe Checkout starter

## Files

- `api/health.js` — confirms the Vercel API is running.
- `api/create-checkout-session.js` — validates the cart and creates a Stripe-hosted Checkout Session.
- `.env.example` — environment variable names only.
- `package.json` — Node/Stripe dependency configuration.

## Vercel setup

1. Copy these files into the root of the empty `pipepilot-api` repository.
2. Commit and push to `main`.
3. Import the repository into Vercel, or redeploy if already imported.
4. In Vercel: **Project → Settings → Environment Variables**
5. Add `STRIPE_SECRET_KEY` using a Stripe **test-mode** secret key.
6. Add `ALLOWED_ORIGINS` with:
   `http://127.0.0.1:5500,http://localhost:5500,https://pipepilotapp.com,https://www.pipepilotapp.com`
7. Redeploy after adding environment variables.

## Tests

Open:

- `https://YOUR-VERCEL-DOMAIN.vercel.app/api/health`

Expected response:

```json
{"ok":true,"service":"pipepilot-api","environment":"production"}
```

The checkout route expects:

```json
{
  "items": [
    {"sku":"PP-001","quantity":2},
    {"sku":"PP-003","quantity":1}
  ]
}
```

## Important

- Prices are controlled server-side. The browser never supplies trusted prices.
- Checkout is limited to Canadian shipping addresses.
- Tax calculation is intentionally not enabled yet.
- Inventory is currently a checkout limit, not shared live inventory.
- Webhook fulfillment and stock deduction come next.
