import { Pool } from "@neondatabase/serverless";

export default async function handler(req, res) {
  if (req.method !== "GET") {
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

  const { userid } = req.query;

  if (!userid) {
    return res.status(400).json({
      error: "Missing userid",
    });
  }

  const telegram_user_id = Number(userid);

  if (!Number.isSafeInteger(telegram_user_id)) {
    return res.status(400).json({
      error: "Invalid Telegram user ID",
    });
  }

  const pool = new Pool({
    connectionString: databaseUrl,
  });

  let client;

  try {
    client = await pool.connect();

    await client.query("BEGIN");

    const result = await client.query(
      `
        INSERT INTO daily_boosts (
          telegram_user_id,
          ads_completed,
          boost_started_at,
          boost_expires_at
        )
        VALUES (
          $1,
          1,
          NULL,
          NULL
        )

        ON CONFLICT (telegram_user_id)
        DO UPDATE SET

          ads_completed =
            CASE

              -- Boost masih aktif:
              -- jangan tambah atau extend
              WHEN
                daily_boosts.boost_expires_at IS NOT NULL
                AND daily_boosts.boost_expires_at > NOW()
              THEN daily_boosts.ads_completed

              -- Hari baru:
              -- mulai hitungan baru dari 1
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

              -- Hari yang sama dan belum 3:
              -- tambah 1
              WHEN daily_boosts.ads_completed < 3
              THEN daily_boosts.ads_completed + 1

              -- Sudah 3/3:
              -- tetap 3, tidak bisa tambah lagi
              ELSE 3

            END,

          boost_started_at =
            CASE

              -- Boost masih aktif
              WHEN
                daily_boosts.boost_expires_at IS NOT NULL
                AND daily_boosts.boost_expires_at > NOW()
              THEN daily_boosts.boost_started_at

              -- Hari baru, hitungan kembali 1
              -- jadi belum mendapatkan boost
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

              -- Iklan ini membuat total menjadi 3
              WHEN daily_boosts.ads_completed = 2
              THEN NOW()

              -- Sudah pernah mencapai 3/3
              ELSE daily_boosts.boost_started_at

            END,

          boost_expires_at =
            CASE

              -- Boost masih aktif
              WHEN
                daily_boosts.boost_expires_at IS NOT NULL
                AND daily_boosts.boost_expires_at > NOW()
              THEN daily_boosts.boost_expires_at

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

              -- Iklan ketiga selesai:
              -- aktifkan boost 1 jam
              WHEN daily_boosts.ads_completed = 2
              THEN NOW() + INTERVAL '1 hour'

              -- Sudah 3/3 dan boost sudah selesai:
              -- jangan aktifkan lagi hari ini
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

    return res.status(200).json({
      success: true,
      telegram_user_id: boost.telegram_user_id,
      ads_completed: boost.ads_completed,
      boost_active:
        boost.boost_expires_at !== null &&
        new Date(boost.boost_expires_at) > new Date(),
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
