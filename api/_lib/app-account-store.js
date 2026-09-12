export async function upsertAppAccount(sql, identity) {
  const rows = await sql`
    INSERT INTO app_accounts (auth_subject, normalized_email)
    VALUES (${identity.subject}, ${identity.email})
    ON CONFLICT (auth_subject) DO UPDATE
    SET normalized_email = EXCLUDED.normalized_email, updated_at = NOW()
    RETURNING id, auth_subject, normalized_email, stripe_customer_id,
              mailerlite_subscriber_id, marketing_consent, suspended_at
  `;
  return rows[0];
}

export async function currentAppEntitlement(sql, accountId) {
  const rows = await sql`
    SELECT tier, status, paid_through, cancel_at_period_end,
           stripe_product_id, stripe_price_id, stripe_subscription_id
    FROM app_entitlements
    WHERE account_id = ${accountId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
