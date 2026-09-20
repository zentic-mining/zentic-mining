export default function handler(req, res) {
  const token = process.env.BOT_TOKEN;
  res.status(200).json({
    method: req.method,
    telegram_token_configured: Boolean(token),
    token_length: token ? token.length : 0,
    node_version: process.versions.node
  });
}
