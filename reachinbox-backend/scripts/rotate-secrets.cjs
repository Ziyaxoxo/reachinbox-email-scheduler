// One-off helper: rotate local secrets in .env. Not part of the runtime.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
let s = fs.readFileSync(envPath, "utf8");

const next = (n) => crypto.randomBytes(n).toString("base64");

s = s.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${next(48)}`);
s = s.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${next(32)}`);

if (!/^DASHBOARD_TOKEN=/m.test(s)) {
  s = s.replace(
    /^ENCRYPTION_KEY=(.*)$/m,
    [
      "ENCRYPTION_KEY=$1",
      "",
      "# BullMQ dashboard (operator-only, read-only).",
      "# Access with: curl -H 'Authorization: Bearer <token>' http://localhost:3000/admin/queues",
      `DASHBOARD_TOKEN=${crypto.randomBytes(32).toString("hex")}`,
      "DASHBOARD_READ_ONLY=true",
    ].join("\n"),
  );
}

fs.writeFileSync(envPath, s);
console.log("Rotated JWT_SECRET, ENCRYPTION_KEY; ensured DASHBOARD_TOKEN.");
