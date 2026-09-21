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

    await client.query("BEGIN");

    const axesResult = await client.query(
      `
        SELECT
          id,
          telegram_user_id,
          item,
          claimed_at,
          expires_at,
          last_mined_at,
          mining_remainder,

          LEAST(NOW(), expires_at) AS effective_now,

          GREATEST(
            0,
            EXTRACT(
              EPOCH FROM (
                LEAST(NOW(), expires_at)
                - COALESCE(last_mined_at, claimed_at)
              )
            ) / 3600.0
          )
          *
          CASE item
            WHEN 'stone_axe' THEN 2750.0 / 24.0
            WHEN 'iron_axe' THEN 100000.0 / 24.0
            WHEN 'steel_axe' THEN 300000.0 / 24.0
            ELSE 0.0
          END
          +
          mining_remainder
          AS total_available

        FROM user_inventory

        WHERE telegram_user_id = $1
          AND status = 'active'

        FOR UPDATE
      `,
      [telegram_user_id]
    );

    let totalEarned = 0;

    for (const axe of axesResult.rows) {
      const totalAvailable = Number(axe.total_available);

      const wholeZentic = Math.floor(totalAvailable);

      const newRemainder =
        totalAvailable - wholeZentic;

      await client.query(
        `
          UPDATE user_inventory

          SET
            last_mined_at = $1,
            mining_remainder = $2

          WHERE id = $3
            AND telegram_user_id = $4
            AND status = 'active'
        `,
        [
          axe.effective_now,
          newRemainder,
          axe.id,
          telegram_user_id,
        ]
      );

      totalEarned += wholeZentic;
    }

    if (totalEarned > 0) {
      await client.query(
        `
          INSERT INTO users (
            telegram_user_id,
            zentic_balance
          )

          VALUES (
            $1,
            $2
          )

          ON CONFLICT (telegram_user_id)

          DO UPDATE SET
            zentic_balance =
              users.zentic_balance + EXCLUDED.zentic_balance,
            updated_at = NOW()
        `,
        [telegram_user_id, totalEarned]
      );
    }

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      earned_zentic: totalEarned,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Mining rollback error:",
          rollbackError
        );
      }
    }

    console.error("Mining error:", error);

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
