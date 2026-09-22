export default async function handler(req, res) {
  return res.status(503).json({
    error: "Daily Boost temporarily disabled",
  });
}
