import { neon } from "@neondatabase/serverless";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return res.status(500).json({
      error: "Database is not configured",
    });
  }

  try {
    const { telegram_user_id } = req.body || {};

    if (!telegram_user_id) {
      return res.status(400).json({
        error: "Missing Telegram user ID",
      });
    }

    const sql = neon(databaseUrl);

    const axes = await sql`
      SELECT
        id,
        item,
        status,
        claimed_at,
        expires_at,
        last_mined_at
      FROM user_inventory
      WHERE telegram_user_id = ${telegram_user_id}
        AND status = 'active'
      ORDER BY claimed_at ASC
    `;

    const ratesPerHour = {
      stone_axe: 2750 / 24,
      iron_axe: 100000 / 24,
      steel_axe: 300000 / 24,
    };

    const now = Date.now();

    let totalEarnedZentic = 0;

    for (const axe of axes) {
      const claimedAt = new Date(axe.claimed_at).getTime();
      const expiresAt = new Date(axe.expires_at).getTime();

      const lastMinedAt = axe.last_mined_at
        ? new Date(axe.last_mined_at).getTime()
        : claimedAt;

      const effectiveNow = Math.min(now, expiresAt);

      const elapsedHours = Math.max(
        0,
        (effectiveNow - lastMinedAt) / (1000 * 60 * 60)
      );

      const ratePerHour = ratesPerHour[axe.item] || 0;

      const earnedZentic = elapsedHours * ratePerHour;

      if (earnedZentic <= 0) {
        continue;
      }

      await sql`
        UPDATE user_inventory
        SET last_mined_at = TO_TIMESTAMP(${effectiveNow / 1000})
        WHERE id = ${axe.id}
          AND telegram_user_id = ${telegram_user_id}
          AND status = 'active'
      `;

      totalEarnedZentic += earnedZentic;
    }

    if (totalEarnedZentic > 0) {
      await sql`
        INSERT INTO users (
          telegram_user_id,
          zentic_balance
        )
        VALUES (
          ${telegram_user_id},
          ${totalEarnedZentic}
        )
        ON CONFLICT (telegram_user_id)
        DO UPDATE SET
          zentic_balance = users.zentic_balance + ${totalEarnedZentic},
          updated_at = NOW()
      `;
    }

    return res.status(200).json({
      success: true,
      earned_zentic: totalEarnedZentic,
    });
    } catch (error) {
    console.error("Mining error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
