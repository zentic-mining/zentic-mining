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
    let start_param;

    try {
      const telegramAuth =
        validateTelegramInitData(initData);

      telegram_user_id =
        telegramAuth.telegram_user_id;

      start_param =
        telegramAuth.start_param;
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

    await client.query("BEGIN");

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
        FOR UPDATE
      `,
      [
        inventory_id,
        telegram_user_id,
      ]
    );

    if (inventoryResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Axe not found",
      });
    }

    const axe = inventoryResult.rows[0];

    if (axe.status !== "ready") {
      await client.query("ROLLBACK");

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
      await client.query("ROLLBACK");

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
      await client.query("ROLLBACK");

      return res.status(409).json({
        error: "Axe could not be started",
      });
    }

    let referral_rewarded = false;
    let referral_reward = 0;

    /*
     * Referral reward:
     * Referred player gets their first successful START MINING.
     * Referrer receives 10,000 Zentic exactly once.
     */
    if (start_param) {
      const referrer_telegram_user_id =
        Number(start_param);

      if (
        Number.isSafeInteger(
          referrer_telegram_user_id
        ) &&
        referrer_telegram_user_id !==
          telegram_user_id
      ) {
        const referrerResult =
          await client.query(
            `
              SELECT telegram_user_id
              FROM users
              WHERE telegram_user_id = $1
              LIMIT 1
            `,
            [referrer_telegram_user_id]
          );

        if (referrerResult.rows.length > 0) {
          /*
           * Record the referral if it has not
           * already been recorded.
           */
          await client.query(
            `
              INSERT INTO referrals (
                referrer_telegram_user_id,
                referred_telegram_user_id,
                status
              )
              VALUES ($1, $2, 'pending')
              ON CONFLICT (referred_telegram_user_id)
              DO NOTHING
            `,
            [
              referrer_telegram_user_id,
              telegram_user_id,
            ]
          );
        }
      }
    }

    /*
     * Reward the existing pending referral.
     * The UPDATE condition guarantees this can
     * happen only once.
     */
    const referralResult = await client.query(
      `
        UPDATE referrals

        SET
          status = 'rewarded',
          rewarded_at = NOW()

        WHERE referred_telegram_user_id = $1
          AND status = 'pending'

        RETURNING
          referrer_telegram_user_id
      `,
      [telegram_user_id]
    );

    if (referralResult.rows.length > 0) {
      const referrerId =
        referralResult.rows[0]
          .referrer_telegram_user_id;

      await client.query(
        `
          INSERT INTO users (
            telegram_user_id,
            zentic_balance
          )
          VALUES ($1, 10000)
          ON CONFLICT (telegram_user_id)
          DO UPDATE SET
            zentic_balance =
              users.zentic_balance + 10000,
            updated_at = NOW()
        `,
        [referrerId]
      );

      referral_rewarded = true;
      referral_reward = 10000;
    }

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      axe: started.rows[0],
      referral_rewarded,
      referral_reward,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Start Mining rollback error:",
          rollbackError
        );
      }
    }

    console.error(
      "Start Mining error:",
      error
    );

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
