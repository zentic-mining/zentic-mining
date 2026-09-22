import { neon } from "@neondatabase/serverless";
import { validateTelegramInitData } from "./telegram-auth.js";

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
    const { initData } = req.body || {};

let telegram_user_id;

try {
  const telegramAuth =
    validateTelegramInitData(initData);

  telegram_user_id =
    telegramAuth.telegram_user_id;
} catch (error) {
  return res.status(401).json({
    error:
      error.message ||
      "Invalid Telegram authentication",
  });
}

    const sql = neon(databaseUrl);

    const axes = await sql`
      SELECT
        id,
        item,
        status,
        claimed_at,
        expires_at
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

    const mining = axes.map((axe) => {
      const claimedAt = new Date(axe.claimed_at).getTime();
      const expiresAt = new Date(axe.expires_at).getTime();

      const effectiveNow = Math.min(now, expiresAt);

      const elapsedHours = Math.max(
        0,
        (effectiveNow - claimedAt) / (1000 * 60 * 60)
      );

      const ratePerHour = ratesPerHour[axe.item] || 0;

      const earnedZentic = elapsedHours * ratePerHour;

      return {
        inventory_id: axe.id,
        item: axe.item,
        status: axe.status,
        claimed_at: axe.claimed_at,
        expires_at: axe.expires_at,
        elapsed_hours: elapsedHours,
        rate_per_hour: ratePerHour,
        earned_zentic: earnedZentic,
      };
    });

    const totalEarnedZentic = mining.reduce(
      (total, axe) => total + axe.earnedZentic,
      0
    );

    return res.status(200).json({
      success: true,
      mining,
      total_earned_zentic: totalEarnedZentic,
    });
  } catch (error) {
    console.error("Mining status error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
