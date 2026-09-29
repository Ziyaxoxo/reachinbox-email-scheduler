import { defineConfig } from "drizzle-kit";
import "dotenv/config";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://reachinbox:reachinbox@localhost:5432/reachinbox",
  },
  verbose: true,
  strict: true,
});
