import { Pool } from "@neondatabase/serverless";

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
    const { telegram_user_id } = req.body || {};

    if (!telegram_user_id) {
      return res.status(400).json({
        error: "Missing Telegram user ID",
      });
    }

    client = await pool.connect();

    const userResult = await client.query(
      `
        SELECT
          telegram_user_id,
          zentic_balance,
          updated_at
        FROM users
        WHERE telegram_user_id = $1
      `,
      [telegram_user_id]
    );

    const inventoryResult = await client.query(
      `
        SELECT
          id,
          item,
          status,
          claimed_at,
          expires_at,
          last_mined_at,
          mining_remainder
        FROM user_inventory
        WHERE telegram_user_id = $1
        ORDER BY id ASC
      `,
      [telegram_user_id]
    );

    const user = userResult.rows[0] || null;

    return res.status(200).json({
      success: true,
      user,
      inventory: inventoryResult.rows,
    });
  } catch (error) {
    console.error("Player error:", error);

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
