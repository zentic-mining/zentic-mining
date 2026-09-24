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

    client = await pool.connect();

    await client.query("BEGIN");

const existingBoost = await client.query(
  `
    SELECT
      ads_completed,
      updated_at,
      boost_expires_at
    FROM daily_boosts
    WHERE telegram_user_id = $1
  `,
  [telegram_user_id]
);

if (existingBoost.rows.length > 0) {
  const boost = existingBoost.rows[0];

  const todayJakarta =
    new Date().toLocaleDateString(
      "en-CA",
      {
        timeZone: "Asia/Jakarta"
      }
    );

  const updatedDateJakarta =
    new Date(boost.updated_at).toLocaleDateString(
      "en-CA",
      {
        timeZone: "Asia/Jakarta"
      }
    );

  if (
    todayJakarta === updatedDateJakarta &&
    boost.ads_completed >= 3
  ) {
    await client.query("ROLLBACK");

    return res.status(400).json({
      error:
        "Daily Boost already used today.",
      ads_completed: 3,
      boost_active:
        boost.boost_expires_at !== null &&
        new Date(boost.boost_expires_at) > new Date()
    });
  }
}
    /*
      Ambil data Daily Boost user.
      Kalau belum ada, buat record baru.
    */

    const result = await client.query(
      `
        INSERT INTO daily_boosts (
          telegram_user_id,
          ads_completed
        )
        VALUES ($1, 1)

        ON CONFLICT (telegram_user_id)
        DO UPDATE SET

          ads_completed =
            CASE

              -- Hari baru
              WHEN
                (
                  daily_boosts.updated_at
                  AT TIME ZONE 'Asia/Jakarta'
                )::date
                <
                (
                  NOW()
                  AT TIME ZONE 'Asia/Jakarta'
                )::date
              THEN 1

              -- Belum mencapai 3 iklan
              WHEN daily_boosts.ads_completed < 3
              THEN daily_boosts.ads_completed + 1

              -- Sudah 3 iklan
              ELSE 3

            END,

          boost_started_at =
            CASE

              -- Hari baru
              WHEN
                (
                  daily_boosts.updated_at
                  AT TIME ZONE 'Asia/Jakarta'
                )::date
                <
                (
                  NOW()
                  AT TIME ZONE 'Asia/Jakarta'
                )::date
              THEN NULL

              -- Iklan ke-3
              WHEN daily_boosts.ads_completed = 2
              THEN NOW()

              ELSE daily_boosts.boost_started_at

            END,

          boost_expires_at =
            CASE

              -- Hari baru
              WHEN
                (
                  daily_boosts.updated_at
                  AT TIME ZONE 'Asia/Jakarta'
                )::date
                <
                (
                  NOW()
                  AT TIME ZONE 'Asia/Jakarta'
                )::date
              THEN NULL

              -- Iklan ke-3
              WHEN daily_boosts.ads_completed = 2
              THEN NOW() + INTERVAL '1 hour'

              ELSE daily_boosts.boost_expires_at

            END,

          updated_at = NOW()

        RETURNING
          telegram_user_id,
          ads_completed,
          boost_started_at,
          boost_expires_at,
          updated_at
      `,
      [telegram_user_id]
    );

    await client.query("COMMIT");

    const boost = result.rows[0];

    const boostActive =
      boost.boost_expires_at !== null &&
      new Date(boost.boost_expires_at) > new Date();

    return res.status(200).json({
      success: true,
      ads_completed: boost.ads_completed,
      boost_active: boostActive,
      boost_started_at: boost.boost_started_at,
      boost_expires_at: boost.boost_expires_at,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Daily Boost rollback error:",
          rollbackError
        );
      }
    }

    console.error("Daily Boost error:", error);

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
