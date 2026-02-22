const express = require("express");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
};

if (
  !serviceAccount.projectId ||
  !serviceAccount.clientEmail ||
  !serviceAccount.privateKey
) {
  console.error("❌ Missing Firebase credentials");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log("✅ Firebase Admin initialized");

const db = admin.firestore();

// SIMPLE USER FETCHER - Just what you want!
app.get("/users", async (req, res) => {
  console.log("📋 Fetching users...");

  try {
    const usersSnapshot = await db.collection("users").get();
    const users = [];

    usersSnapshot.forEach((doc) => {
      users.push({
        id: doc.id,
        // Add any fields you want to see
        email: doc.data().email || "no email",
        // You can add more fields as needed
      });
    });

    console.log(`✅ Found ${users.length} users`);
    res.json({
      success: true,
      count: users.length,
      users: users,
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// 🔥 NEW TEST ENDPOINT - Paste this here!
app.get("/test", async (req, res) => {
  try {
    // Just try to list collections
    const collections = await db.listCollections();
    res.json({
      success: true,
      collections: collections.map((c) => c.id),
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "User fetcher running" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
