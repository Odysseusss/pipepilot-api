export async function administratorAccountCount(sql, capabilities) {
  if (capabilities.administrator !== true) return {};
  try {
    const rows = await sql`SELECT COUNT(*) AS total FROM app_accounts`;
    const total = Number(rows[0]?.total);
    return Number.isSafeInteger(total) && total >= 0
      ? { registeredAccountCount: total }
      : {};
  } catch {
    // Optional statistics must never interrupt account access.
    return {};
  }
}