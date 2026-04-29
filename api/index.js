const express = require("express");
const serverless = require("serverless-http");

const app = express();

app.get("/", (req, res) => {
  res.json({ message: "Working on Vercel 🚀" });
});

module.exports = serverless(app);