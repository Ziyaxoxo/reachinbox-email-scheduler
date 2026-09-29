/**
 * Prints a session token for manual browser inspection.
 *
 * Same mechanism the E2E harness uses: no login backdoor, a real HS256 JWT
 * signed with the backend's JWT_SECRET over a directly-inserted user row.
 * Line 1 is `user=<id>`, line 2 is the token.
 */
import { seedUser } from "./seed.js";

const seeded = await seedUser(`manual-${Date.now()}`);

console.log(`user=${seeded.userId}`);
console.log(seeded.token);
