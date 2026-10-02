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

## Petey

`POST /api/petey` is the server-side Petey proxy. It keeps the OpenAI key out
of Flutter and browser builds, sends requests with `store: false`, requires a
strict intent response, and never receives direct drawing tools.

Configure `OPENAI_API_KEY` in Vercel. `PETEY_MODEL` defaults to
`gpt-5-mini`. `PETEY_ALLOWED_ORIGINS` is optional; the production Pipe Pilot
origins and private-network HTTP origins used for device testing are accepted
by default. Environment-variable changes require a new deployment.

## Speech-to-Pipe beta

`POST /api/app/speech-to-pipe` is the authenticated paid interpretation route.
It defaults to `gpt-6-luna` with reasoning disabled, asks the model only for a
strict drawing-operation schema, and leaves compatibility, catalog lookup,
geometry, preview, and undo to Pipe Pilot.

Configure `OPENAI_API_KEY`, `SPEECH_TO_PIPE_MODEL`,
`SPEECH_TO_PIPE_REASONING_EFFORT`, and `SPEECH_TO_PIPE_DAILY_LIMIT` in Vercel.
The model defaults to `gpt-6-luna`, reasoning defaults to `none`, and the daily
allowance defaults to 10 paid-account submissions. Apply migration 003 before
deploying this route.

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

## App account billing (test mode)

The app subscription routes are separate from merchandise:

- `POST /api/app/checkout` creates authenticated annual Checkout.
- `POST /api/app/portal` opens billing management for the authenticated customer.
- `POST /api/app/stripe-webhook` reconciles signed app billing events.

Configure these variables only with Stripe test-mode resources until launch approval:

- `STRIPE_APP_PRODUCT_ID`
- `STRIPE_APP_ANNUAL_PRICE_ID`
- `STRIPE_APP_SECRET_KEY`
- `STRIPE_APP_CURRENCY`
- `STRIPE_APP_ANNUAL_AMOUNT` (currently `1499`)
- `STRIPE_APP_WEBHOOK_SECRET`
- `MAILERLITE_API_KEY`
- `MAILERLITE_APP_GROUP_ID`

The configured Price must be active, recurring yearly, and match the configured product,
currency, and amount. A Checkout return does not grant access; a signed paid invoice does.
MailerLite enrollment is separate from account access and occurs only after an explicit
newsletter opt-in from a verified user.
