import Stripe from "stripe";
import { neon } from "@neondatabase/serverless";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const databaseUrl =
  process.env.STORAGE_DATABASE_URL_UNPOOLED;

const sql = databaseUrl ? neon(databaseUrl) : null;

function parseCart(cartReference) {
  if (!cartReference) {
    return [];
  }

  return cartReference.split(",").map((entry) => {
    const [skuRaw, quantityRaw] = entry.split(":");

    const sku = String(skuRaw ?? "").trim();
    const quantity = Number(quantityRaw);

    if (!sku || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Invalid cart metadata entry: ${entry}`);
    }

    return {
      sku,
      quantity,
    };
  });
}

export async function POST(request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = request.headers.get("stripe-signature");

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured.");

    return Response.json(
      { error: "Webhook is not configured." },
      { status: 500 }
    );
  }

  if (!databaseUrl || !sql) {
    console.error(
      "STORAGE_DATABASE_URL_UNPOOLED is not configured."
    );

    return Response.json(
      { error: "Database is not configured." },
      { status: 500 }
    );
  }

  if (!signature) {
    return Response.json(
      { error: "Missing Stripe signature." },
      { status: 400 }
    );
  }

  // Stripe signature verification requires the ORIGINAL raw request body.
  const rawBody = await request.text();

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret
    );
  } catch (error) {
    console.error(
      "Webhook signature verification failed:",
      error instanceof Error ? error.message : error
    );

    return Response.json(
      { error: "Invalid webhook signature." },
      { status: 400 }
    );
  }

  console.log(
    `Stripe webhook verified: ${event.type} (${event.id})`
  );

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        console.log("Checkout completed:", {
          eventId: event.id,
          sessionId: session.id,
          paymentStatus: session.payment_status,
          amountTotal: session.amount_total,
          currency: session.currency,
          customerEmail:
            session.customer_details?.email ?? null,
          cart: session.metadata?.cart ?? null,
        });

        // Only reduce inventory for completed paid sessions.
        if (session.payment_status !== "paid") {
          console.log(
            `Inventory not changed because session ${session.id} is ${session.payment_status}.`
          );

          break;
        }

        const cart = parseCart(session.metadata?.cart);

        if (cart.length === 0) {
          throw new Error(
            `Checkout Session ${session.id} has no cart metadata.`
          );
        }

        for (const item of cart) {
          await sql`
            INSERT INTO inventory_transactions (
              sku,
              delta,
              transaction_type,
              source,
              reason,
              reference_id
            )
            VALUES (
              ${item.sku},
              ${-item.quantity},
              'sale',
              'stripe',
              'Stripe Checkout sale',
              ${session.id}
            )
            ON CONFLICT (
              source,
              reference_id,
              sku
            )
            DO NOTHING
          `;
        }

        console.log("Inventory processed:", {
          sessionId: session.id,
          items: cart,
        });

        break;
      }

      default:
        console.log(
          `Unhandled Stripe event: ${event.type}`
        );
    }
  } catch (error) {
    console.error(
      "Webhook processing failed:",
      error instanceof Error ? error.message : error
    );

    // Returning 500 tells Stripe the webhook was not successfully processed,
    // so Stripe can retry it.
    return Response.json(
      { error: "Webhook processing failed." },
      { status: 500 }
    );
  }

  return Response.json({
    received: true,
    eventId: event.id,
  });
}
