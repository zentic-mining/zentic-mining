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
    const { initData, start_param } = req.body || {};

    let referred_telegram_user_id;

    try {
      const telegramAuth = validateTelegramInitData(initData);

      referred_telegram_user_id =
        telegramAuth.telegram_user_id;
    } catch (error) {
      return res.status(401).json({
        error: error.message || "Invalid Telegram authentication",
      });
    }

    if (!start_param) {
      return res.status(400).json({
        error: "Missing referral parameter",
      });
    }

    const referrer_telegram_user_id =
      Number(start_param);

    if (!Number.isSafeInteger(referrer_telegram_user_id)) {
      return res.status(400).json({
        error: "Invalid referral parameter",
      });
    }

    if (
      referrer_telegram_user_id ===
      referred_telegram_user_id
    ) {
      return res.status(400).json({
        error: "Self referral is not allowed",
      });
    }

    client = await pool.connect();

    const referrerResult = await client.query(
      `
        SELECT telegram_user_id
        FROM users
        WHERE telegram_user_id = $1
      `,
      [referrer_telegram_user_id]
    );

    if (referrerResult.rows.length === 0) {
      return res.status(400).json({
        error: "Referrer does not exist",
      });
    }

    await client.query(
      `
        INSERT INTO referrals (
          referrer_telegram_user_id,
          referred_telegram_user_id
        )
        VALUES ($1, $2)
        ON CONFLICT (referred_telegram_user_id)
        DO NOTHING
      `,
      [
        referrer_telegram_user_id,
        referred_telegram_user_id,
      ]
    );

    return res.status(200).json({
      success: true,
    });
  } catch (error) {
    console.error("Referral error:", error);

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
