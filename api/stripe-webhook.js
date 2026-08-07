import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

  if (!signature) {
    return Response.json(
      { error: "Missing Stripe signature." },
      { status: 400 }
    );
  }

  // IMPORTANT:
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
    console.error("Webhook signature verification failed:", error.message);

    return Response.json(
      { error: "Invalid webhook signature." },
      { status: 400 }
    );
  }

  console.log(`Stripe webhook verified: ${event.type} (${event.id})`);

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

      break;
    }

    default:
      console.log(`Unhandled Stripe event: ${event.type}`);
  }

  return Response.json({
    received: true,
    eventId: event.id,
  });
}
