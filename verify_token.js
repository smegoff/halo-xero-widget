// verify_token.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config(); // loads .env where HALO_JWT_SECRET lives

const token = process.argv[2]; // pass JWT on command line
if (!token) {
  console.error("⚠️  Usage: node verify_token.js <jwt_token>");
  process.exit(1);
}

try {
  const decoded = jwt.verify(token, process.env.HALO_JWT_SECRET);
  console.log("✅ Token is valid!");
  console.log("Decoded payload:", decoded);
} catch (err) {
  console.error("❌ Invalid token:", err.message);
}
