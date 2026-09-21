import { neon } from "@neondatabase/serverless";

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
    const { telegram_user_id } = req.body || {};

    if (!telegram_user_id) {
      return res.status(400).json({
        error: "Missing Telegram user ID",
      });
    }

    const sql = neon(databaseUrl);

    const result = await sql`
      WITH axe_data AS (
        SELECT
          id,
          telegram_user_id,
          item,
          claimed_at,
          expires_at,
          last_mined_at,
          COALESCE(last_mined_at, claimed_at) AS checkpoint,
          LEAST(NOW(), expires_at) AS effective_now,

          CASE item
            WHEN 'stone_axe' THEN 2750.0 / 24.0
            WHEN 'iron_axe' THEN 100000.0 / 24.0
            WHEN 'steel_axe' THEN 300000.0 / 24.0
            ELSE 0.0
          END AS rate_per_hour

        FROM user_inventory
        WHERE telegram_user_id = ${telegram_user_id}
          AND status = 'active'
      ),

      calculated AS (
        SELECT
          *,
          GREATEST(
            0.0,
            EXTRACT(
              EPOCH FROM (effective_now - checkpoint)
            ) / 3600.0 * rate_per_hour
          ) AS earned
        FROM axe_data
      ),

      credits AS (
        SELECT
          *,
          FLOOR(earned) AS whole_zentic
        FROM calculated
      ),

      updated_axes AS (
        UPDATE user_inventory ui
        SET last_mined_at =
          c.checkpoint
          + (
              c.whole_zentic / NULLIF(c.rate_per_hour, 0)
            ) * INTERVAL '1 hour'

        FROM credits c

        WHERE ui.id = c.id
          AND ui.telegram_user_id = ${telegram_user_id}
          AND ui.status = 'active'
          AND c.whole_zentic > 0
          AND ui.last_mined_at IS NOT DISTINCT FROM c.last_mined_at

        RETURNING c.whole_zentic
      ),

      total_credit AS (
        SELECT
          COALESCE(
            SUM(whole_zentic),
            0
          )::BIGINT AS amount
        FROM updated_axes
      ),

      balance_update AS (
        INSERT INTO users (
          telegram_user_id,
          zentic_balance
        )
        SELECT
          ${telegram_user_id},
          amount
        FROM total_credit
        WHERE amount > 0

        ON CONFLICT (telegram_user_id)
        DO UPDATE SET
          zentic_balance =
            users.zentic_balance + EXCLUDED.zentic_balance,
          updated_at = NOW()

        RETURNING zentic_balance
      )

      SELECT
        amount AS earned_zentic
      FROM total_credit
    `;

    const earnedZentic = Number(result[0]?.earned_zentic || 0);

    return res.status(200).json({
      success: true,
      earned_zentic: earnedZentic,
    });

  } catch (error) {
    console.error("Mining error:", error);

      return res.status(500).json({
      error: "Internal server error",
    });
  }
}
