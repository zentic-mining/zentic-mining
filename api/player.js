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

    try {
      const telegramAuth = validateTelegramInitData(initData);

      telegram_user_id =
        telegramAuth.telegram_user_id;
    } catch (error) {
      return res.status(401).json({
        error:
          error.message ||
          "Invalid Telegram authentication",
      });
    }

    client = await pool.connect();

    await client.query("BEGIN");
        // Create player if this is a new Telegram user
    await client.query(
      `
        INSERT INTO users (
          telegram_user_id,
          zentic_balance,
          starter_claimed
        )
        VALUES (
          $1,
          0,
          false
        )
        ON CONFLICT (telegram_user_id)
        DO NOTHING
      `,
      [telegram_user_id]
    );

    // Give the player one starter Stone Axe
    // only if they have not received the starter pack yet.
    const starterResult = await client.query(
      `
        SELECT starter_claimed
        FROM users
        WHERE telegram_user_id = $1
        FOR UPDATE
      `,
      [telegram_user_id]
    );

    if (
      starterResult.rows.length > 0 &&
      starterResult.rows[0].starter_claimed === false
    ) {
      const existingStoneAxe = await client.query(
        `
          SELECT id
          FROM user_inventory
          WHERE telegram_user_id = $1
            AND item = 'stone_axe'
          LIMIT 1
        `,
        [telegram_user_id]
      );

      if (existingStoneAxe.rows.length === 0) {
        await client.query(
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
              'stone_axe',
              'ready',
              NULL,
              NULL,
              NULL,
              0
            )
          `,
          [telegram_user_id]
        );
      }

      await client.query(
        `
          UPDATE users
          SET
            starter_claimed = true,
            updated_at = NOW()
          WHERE telegram_user_id = $1
        `,
        [telegram_user_id]
      );
    }

    const inventoryResult = await client.query(
      `
        SELECT
          id,
          telegram_user_id,
          item,
          status,
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

    for (const axe of inventoryResult.rows) {
      const totalAvailable =
        Number(axe.total_available);

      const wholeZentic =
        Math.floor(totalAvailable);

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
        [
          telegram_user_id,
          totalEarned,
        ]
      );
    }

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

    const updatedInventoryResult =
      await client.query(
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

    await client.query("COMMIT");

    const user =
      userResult.rows[0] || null;

    return res.status(200).json({
      success: true,
      earned_zentic: totalEarned,
      user,
      inventory: updatedInventoryResult.rows,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Player rollback error:",
          rollbackError
        );
      }
    }

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
