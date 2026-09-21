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
    const { telegram_user_id, inventory_id } = req.body || {};

    if (!telegram_user_id || !inventory_id) {
      return res.status(400).json({
        error: "Missing claim information",
      });
    }

    const sql = neon(databaseUrl);

    const inventory = await sql`
      SELECT
        id,
        telegram_user_id,
        item,
        status,
        claimed_at,
        expires_at
      FROM user_inventory
      WHERE id = ${inventory_id}
        AND telegram_user_id = ${telegram_user_id}
      LIMIT 1
    `;

    if (inventory.length === 0) {
      return res.status(404).json({
        error: "Axe not found",
      });
    }

    const axe = inventory[0];

    if (axe.status !== "ready") {
      return res.status(400).json({
        error: "Axe is not available for claiming",
      });
    }

    const durabilityDays = {
      stone_axe: 20,
      iron_axe: 30,
      steel_axe: 45,
    };

    const days = durabilityDays[axe.item];

    if (!days) {
      return res.status(400).json({
        error: "Invalid Axe type",
      });
    }

    const claimed = await sql`
      UPDATE user_inventory
      SET
        status = 'active',
        claimed_at = NOW(),
        expires_at = NOW() + (${days} * INTERVAL '1 day')
      WHERE id = ${inventory_id}
        AND telegram_user_id = ${telegram_user_id}
        AND status = 'ready'
      RETURNING
        id,
        item,
        status,
        claimed_at,
        expires_at
    `;

    if (claimed.length === 0) {
      return res.status(409).json({
        error: "Axe could not be claimed",
      });
    }

    return res.status(200).json({
      success: true,
      axe: claimed[0],
    });
    } catch (error) {
    console.error("Claim Axe error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
