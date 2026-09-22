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

    const users = await sql`
      INSERT INTO users (
        telegram_user_id
      )
      VALUES (
        ${telegram_user_id}
      )
      ON CONFLICT (telegram_user_id)
      DO NOTHING
      RETURNING
        id,
        telegram_user_id,
        starter_claimed
    `;

    if (users.length === 0) {
      const existingUser = await sql`
        SELECT
          id,
          telegram_user_id,
          starter_claimed
        FROM users
        WHERE telegram_user_id = ${telegram_user_id}
        LIMIT 1
      `;

      return res.status(200).json({
        success: true,
        new_user: false,
        user: existingUser[0],
      });
    }

    const user = users[0];

    const starter = await sql`
      INSERT INTO user_inventory (
        telegram_user_id,
        item,
        status
      )
      VALUES (
        ${telegram_user_id},
        'stone_axe',
        'ready'
      )
      RETURNING
        id,
        item,
        status,
        created_at
    `;

    await sql`
      UPDATE users
      SET
        starter_claimed = TRUE,
        updated_at = NOW()
      WHERE telegram_user_id = ${telegram_user_id}
    `;

    return res.status(200).json({
      success: true,
      new_user: true,
      user: {
        id: user.id,
        telegram_user_id: user.telegram_user_id,
        starter_claimed: true,
      },
      starter_axe: starter[0],
    });
  } catch (error) {
    console.error("Start error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
