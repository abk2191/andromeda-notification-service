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

// SIMPLE USER FETCHER - Original (returns 0 users because no documents at root)
app.get("/users", async (req, res) => {
  console.log("📋 Fetching users from root collection...");

  try {
    const usersSnapshot = await db.collection("users").get();
    const users = [];

    usersSnapshot.forEach((doc) => {
      users.push({
        id: doc.id,
        email: doc.data().email || "no email",
      });
    });

    console.log(`✅ Found ${users.length} users at root level`);
    res.json({
      success: true,
      method: "root collection",
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

// 🔥 NEW ENDPOINT - Finds users from subcollections
app.get("/users-from-notifications", async (req, res) => {
  console.log("📋 Fetching users from pushNotifications subcollections...");

  try {
    // Use collectionGroup to find ALL pushNotifications subcollections
    const notificationsSnapshot = await db
      .collectionGroup("pushNotifications")
      .get();

    // Use a Set to collect unique user IDs
    const userIds = new Set();
    const notifications = [];

    notificationsSnapshot.forEach((doc) => {
      // The path format is: users/{userId}/pushNotifications/{notificationId}
      const pathParts = doc.ref.path.split("/");
      const userId = pathParts[1]; // Extract user ID from path

      userIds.add(userId);

      notifications.push({
        id: doc.id,
        userId: userId,
        data: doc.data(),
      });
    });

    console.log(`✅ Found ${userIds.size} unique users from notifications`);
    console.log(`✅ Found ${notifications.length} total notifications`);

    res.json({
      success: true,
      method: "collectionGroup query on pushNotifications",
      uniqueUserCount: userIds.size,
      userIds: Array.from(userIds),
      totalNotifications: notifications.length,
      sampleNotifications: notifications.slice(0, 5), // Show first 5 as sample
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// 🔥 ANOTHER NEW ENDPOINT - Try to find users from fcmTokens subcollections
app.get("/users-from-tokens", async (req, res) => {
  console.log("📋 Fetching users from fcmTokens subcollections...");

  try {
    // Use collectionGroup to find ALL fcmTokens subcollections
    const tokensSnapshot = await db.collectionGroup("fcmTokens").get();

    // Use a Set to collect unique user IDs
    const userIds = new Set();
    const tokens = [];

    tokensSnapshot.forEach((doc) => {
      // The path format is: users/{userId}/fcmTokens/{tokenId}
      const pathParts = doc.ref.path.split("/");
      const userId = pathParts[1]; // Extract user ID from path

      userIds.add(userId);

      tokens.push({
        id: doc.id,
        userId: userId,
        data: doc.data(),
      });
    });

    console.log(`✅ Found ${userIds.size} unique users from fcmTokens`);
    console.log(`✅ Found ${tokens.length} total tokens`);

    res.json({
      success: true,
      method: "collectionGroup query on fcmTokens",
      uniqueUserCount: userIds.size,
      userIds: Array.from(userIds),
      totalTokens: tokens.length,
      sampleTokens: tokens.slice(0, 5), // Show first 5 as sample
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// 🔥 COMPREHENSIVE ENDPOINT - Shows everything
app.get("/debug-full", async (req, res) => {
  console.log("🔍 Running full debug...");

  const result = {
    collections: [],
    rootUsers: 0,
    usersFromNotifications: [],
    usersFromTokens: [],
    notificationsCount: 0,
    tokensCount: 0,
  };

  try {
    // List all collections
    const collections = await db.listCollections();
    result.collections = collections.map((c) => c.id);

    // Check root users
    const usersSnapshot = await db.collection("users").get();
    result.rootUsers = usersSnapshot.size;

    // Get users from pushNotifications
    const notificationsSnapshot = await db
      .collectionGroup("pushNotifications")
      .get();
    result.notificationsCount = notificationsSnapshot.size;
    const notifUsers = new Set();
    notificationsSnapshot.forEach((doc) => {
      const pathParts = doc.ref.path.split("/");
      notifUsers.add(pathParts[1]);
    });
    result.usersFromNotifications = Array.from(notifUsers);

    // Get users from fcmTokens
    const tokensSnapshot = await db.collectionGroup("fcmTokens").get();
    result.tokensCount = tokensSnapshot.size;
    const tokenUsers = new Set();
    tokensSnapshot.forEach((doc) => {
      const pathParts = doc.ref.path.split("/");
      tokenUsers.add(pathParts[1]);
    });
    result.usersFromTokens = Array.from(tokenUsers);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 🔥 NEW TEST ENDPOINT
app.get("/test", async (req, res) => {
  try {
    const collections = await db.listCollections();
    res.json({
      success: true,
      collections: collections.map((c) => c.id),
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get("/debug-auth", async (req, res) => {
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = admin.app().options.credential?.clientEmail;

    res.json({
      success: true,
      projectId: projectId,
      clientEmail: clientEmail || "Not available via this method",
      note: "This confirms Firebase Admin is initialized",
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message,
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "User fetcher running" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Available endpoints:`);
  console.log(`   - /users (root collection)`);
  console.log(
    `   - /users-from-notifications (finds users from pushNotifications)`,
  );
  console.log(`   - /users-from-tokens (finds users from fcmTokens)`);
  console.log(`   - /debug-full (comprehensive view)`);
  console.log(`   - /test (list collections)`);
  console.log(`   - /debug-auth (check credentials)`);
});
