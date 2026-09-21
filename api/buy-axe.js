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
    const { initData, item } = req.body || {};

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

    if (item !== "stone_axe") {
      return res.status(400).json({
        error: "Invalid Axe type",
      });
    }

    const prices = {
      stone_axe: 50000,
    };

    const price = prices[item];

    client = await pool.connect();

    await client.query("BEGIN");

    const userResult = await client.query(
      `
        SELECT
          telegram_user_id,
          zentic_balance
        FROM users
        WHERE telegram_user_id = $1
        FOR UPDATE
      `,
      [telegram_user_id]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Player not found",
      });
    }

    const balance =
      Number(userResult.rows[0].zentic_balance);

    if (balance < price) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Insufficient Zentic balance",
      });
    }

    const purchaseResult = await client.query(
      `
        INSERT INTO user_inventory (
          telegram_user_id,
          item,
          status,
          claimed_at,
          expires_at,
          last_mined_at,
          mining_remainder
        )
        VALUES (
          $1,
          $2,
          'ready',
          NULL,
          NULL,
          NULL,
          0
        )
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
        telegram_user_id,
        item,
      ]
    );

    await client.query(
      `
        UPDATE users
        SET
          zentic_balance =
            zentic_balance - $1,
          updated_at = NOW()
        WHERE telegram_user_id = $2
      `,
      [
        price,
        telegram_user_id,
      ]
    );

    const updatedUserResult = await client.query(
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

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      purchased: item,
      price,
      user: updatedUserResult.rows[0],
      inventory: purchaseResult.rows[0],
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Buy Axe rollback error:",
          rollbackError
        );
      }
    }

    console.error("Buy Axe error:", error);

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
