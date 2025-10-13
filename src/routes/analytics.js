// routes/analytics.js

const express = require("express");
const router = express.Router();
const { getUserAnalytics } = require("../controllers/analytics");

// POST /api/analytics - Get user analytics
router.get("/:userId", getUserAnalytics);

module.exports = router;
