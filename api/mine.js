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
  const { initData } = req.body || {};

let telegram_user_id;
let profileBonusActive = false;

try {
  const telegramAuth = validateTelegramInitData(initData);

  telegram_user_id =
    telegramAuth.telegram_user_id;

  const botToken =
    process.env.TELEGRAM_BOT_TOKEN;

  if (botToken) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/getChat?chat_id=${telegram_user_id}`
      );

      const data =
        await response.json();

      const bio =
        data.result?.bio || "";

      profileBonusActive =
        data.ok &&
        bio
          .toLowerCase()
          .includes("@zenticminingbot");

    } catch (error) {
      console.error(
        "Profile bonus check error:",
        error
      );
    }
  }

} catch (error) {
  return res.status(401).json({
    error:
      error.message ||
      "Invalid Telegram authentication",
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
  WHEN 'stone_axe' THEN
    (2750.0 / 24.0) *
    CASE WHEN $2 = true THEN 1.10 ELSE 1.00 END

  WHEN 'iron_axe' THEN
    (100000.0 / 24.0) *
    CASE WHEN $2 = true THEN 1.10 ELSE 1.00 END

  WHEN 'steel_axe' THEN
    (300000.0 / 24.0) *
    CASE WHEN $2 = true THEN 1.10 ELSE 1.00 END

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
[
  telegram_user_id,
  profileBonusActive
]
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
