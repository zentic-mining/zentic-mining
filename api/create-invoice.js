export default async function handler(req, res) {
  return res.status(200).json({
    method: req.method,
    telegram_token_configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    node_version: process.version
  });
}
