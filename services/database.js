const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

pool.on("connect", () => {
  console.log("🟢 PostgreSQL conectado");
});

pool.on("error", (error) => {
  console.error("🔴 PostgreSQL error:", error.message);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

module.exports = {
  pool,
  query,
};
