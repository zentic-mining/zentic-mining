import { Pool } from "@neondatabase/serverless";
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

  const pool = new Pool({
    connectionString: databaseUrl,
  });

  let client;

  try {
    const { initData, inventory_id } = req.body || {};

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

    if (!inventory_id) {
      return res.status(400).json({
        error: "Missing inventory ID",
      });
    }

    client = await pool.connect();

    const inventoryResult = await client.query(
      `
        SELECT
          id,
          telegram_user_id,
          item,
          status,
          claimed_at,
          expires_at
        FROM user_inventory
        WHERE id = $1
          AND telegram_user_id = $2
        LIMIT 1
      `,
      [
        inventory_id,
        telegram_user_id,
      ]
    );

    if (inventoryResult.rows.length === 0) {
      return res.status(404).json({
        error: "Axe not found",
      });
    }

    const axe = inventoryResult.rows[0];

    if (axe.status !== "ready") {
      return res.status(400).json({
        error: "Axe is not ready to start mining",
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

    const started = await client.query(
      `
        UPDATE user_inventory

        SET
          status = 'active',
          claimed_at = NOW(),
          expires_at =
            NOW() + ($1 * INTERVAL '1 day'),
          last_mined_at = NOW(),
          mining_remainder = 0

        WHERE id = $2
          AND telegram_user_id = $3
          AND status = 'ready'

        RETURNING
          id,
          item,
          status,
          claimed_at,
          expires_at,
          last_mined_at,
          mining_remainder
      `,
      [
        days,
        inventory_id,
        telegram_user_id,
      ]
    );

    if (started.rows.length === 0) {
      return res.status(409).json({
        error: "Axe could not be started",
      });
    }

    return res.status(200).json({
      success: true,
      axe: started.rows[0],
    });
  } catch (error) {
    console.error("Start Mining error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  } finally {
    if (client) {
      client.release();
    }

    await pool.end();
  }
}
