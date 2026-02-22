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

// ============================================
// NOTIFICATION SYSTEM - Main Function
// ============================================

/**
 * Checks for due notifications and sends them via FCM
 * This is the core function that will be called by cron-job.org
 */
async function checkAndSendNotifications() {
  console.log(
    "🔍 Checking for due notifications at:",
    new Date().toISOString(),
  );

  try {
    const now = Date.now();
    const oneMinuteAgo = now - 60000; // Look back 1 minute

    // Use collectionGroup to find ALL due notifications across all users
    const dueNotificationsSnapshot = await db
      .collectionGroup("pushNotifications")
      .where("fireAt", "<=", now)
      .where("fireAt", ">=", oneMinuteAgo)
      .where("status", "==", "scheduled")
      .get();

    console.log(`📋 Found ${dueNotificationsSnapshot.size} due notifications`);

    if (dueNotificationsSnapshot.empty) {
      console.log("⏰ No due notifications found");
      return 0;
    }

    // Group notifications by userId for efficient token fetching
    const notificationsByUser = new Map();

    dueNotificationsSnapshot.forEach((doc) => {
      const pathParts = doc.ref.path.split("/");
      const userId = pathParts[1]; // Extract user ID from path

      if (!notificationsByUser.has(userId)) {
        notificationsByUser.set(userId, []);
      }
      notificationsByUser.get(userId).push({
        id: doc.id,
        ref: doc.ref,
        data: doc.data(),
      });
    });

    console.log(`👥 Found notifications for ${notificationsByUser.size} users`);

    let totalSent = 0;

    // Process each user's notifications
    for (const [userId, userNotifications] of notificationsByUser.entries()) {
      console.log(`\n🔍 Processing user: ${userId}`);

      // Get user's FCM tokens from fcmTokens subcollection
      const tokensSnapshot = await db
        .collection("users")
        .doc(userId)
        .collection("fcmTokens")
        .get();

      const tokens = tokensSnapshot.docs.map((doc) => doc.id);
      const tokenDocs = tokensSnapshot.docs; // Keep full docs for deviceId lookup

      console.log(`   🔑 Found ${tokens.length} FCM tokens for this user`);

      if (tokens.length === 0) {
        console.log(
          `   ⚠️ No tokens for user ${userId} - marking notifications as sent without delivery`,
        );

        // Still mark notifications as sent to prevent re-processing
        for (const notification of userNotifications) {
          await notification.ref.update({
            status: "sent",
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            note: "No FCM tokens available",
          });
        }
        continue;
      }

      // Send each notification for this user with device-aware targeting
      for (const notification of userNotifications) {
        const notificationData = notification.data;
        const creatingDeviceId = notificationData.deviceId;

        console.log(
          `   📤 Processing notification: "${notificationData.body || "No message"}"`,
        );
        console.log(
          `   📱 Created on device: ${creatingDeviceId || "unknown"}`,
        );

        // Prepare base FCM message (without tokens)
        const baseMessage = {
          notification: {
            title: notificationData.title || "🔔 Calendar Reminder",
            body: notificationData.body || "You have an upcoming event",
          },
          data: {
            eventId: notificationData.eventId || "",
            eventName: notificationData.eventName || "",
            dateKey: notificationData.dateKey || "",
            type: "calendar_reminder",
            id: notification.id,
            click_action: "OPEN_CALENDAR",
          },
          // Platform-specific configurations
          android: {
            priority: "high",
            notification: {
              sound: "default",
              priority: "high",
              clickAction: "OPEN_CALENDAR",
            },
          },
          apns: {
            payload: {
              aps: {
                sound: "default",
                badge: 1,
              },
            },
          },
          webpush: {
            headers: {
              Urgency: "high",
            },
            notification: {
              icon: "/andromeda/android-icon-192x192.png",
              badge: "/andromeda/android-icon-192x192.png",
              requireInteraction: true,
              vibrate: [200, 100, 200],
            },
            fcmOptions: {
              link: "/",
            },
          },
        };

        if (!creatingDeviceId) {
          console.log(
            `   ⚠️ No deviceId in notification, sending to all devices as fallback`,
          );

          // Send to all tokens (original behavior)
          const message = { ...baseMessage, tokens: tokens };

          try {
            const response = await admin
              .messaging()
              .sendEachForMulticast(message);
            console.log(
              `   ✅ Fallback response: ${response.successCount} sent, ${response.failureCount} failed`,
            );
            totalSent += response.successCount;

            await notification.ref.update({
              status: "sent",
              sentAt: admin.firestore.FieldValue.serverTimestamp(),
              fcmResponse: {
                successCount: response.successCount,
                failureCount: response.failureCount,
              },
            });

            // Remove invalid tokens
            if (response.failureCount > 0) {
              console.log(
                `   🔄 Removing ${response.failureCount} invalid tokens`,
              );
              response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                  const failedToken = tokens[idx];
                  console.log(
                    `      Removing token: ${failedToken.substring(0, 20)}...`,
                  );
                  db.collection("users")
                    .doc(userId)
                    .collection("fcmTokens")
                    .doc(failedToken)
                    .delete()
                    .catch((err) => console.log("Error removing token:", err));
                }
              });
            }
          } catch (error) {
            console.error(`   ❌ Error sending fallback notification:`, error);
            await notification.ref.update({
              status: "failed",
              error: error.message,
              failedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        } else {
          // Filter tokens to find ones matching this device
          const deviceTokens = [];
          const otherTokens = [];

          tokenDocs.forEach((doc) => {
            const tokenData = doc.data();
            if (tokenData.deviceId === creatingDeviceId) {
              deviceTokens.push(doc.id);
            } else {
              otherTokens.push(doc.id);
            }
          });

          console.log(
            `   📱 Found ${deviceTokens.length} token(s) for creating device, ${otherTokens.length} for other devices`,
          );

          // Send to the creating device first
          if (deviceTokens.length > 0) {
            const deviceMessage = { ...baseMessage, tokens: deviceTokens };

            try {
              const deviceResponse = await admin
                .messaging()
                .sendEachForMulticast(deviceMessage);
              console.log(
                `   ✅ Sent to creating device: ${deviceResponse.successCount} success, ${deviceResponse.failureCount} failed`,
              );
              totalSent += deviceResponse.successCount;

              // Mark notification as sent
              await notification.ref.update({
                status: "sent",
                sentAt: admin.firestore.FieldValue.serverTimestamp(),
                sentToDevice: creatingDeviceId,
                fcmResponse: {
                  successCount: deviceResponse.successCount,
                  failureCount: deviceResponse.failureCount,
                },
              });

              // Remove invalid tokens if any
              if (deviceResponse.failureCount > 0) {
                deviceResponse.responses.forEach((resp, idx) => {
                  if (!resp.success) {
                    const failedToken = deviceTokens[idx];
                    console.log(
                      `      Removing invalid token: ${failedToken.substring(0, 20)}...`,
                    );
                    db.collection("users")
                      .doc(userId)
                      .collection("fcmTokens")
                      .doc(failedToken)
                      .delete()
                      .catch((err) =>
                        console.log("Error removing token:", err),
                      );
                  }
                });
              }
            } catch (error) {
              console.error(`   ❌ Error sending to device:`, error);

              // Mark as failed but try fallback
              await notification.ref.update({
                status: "failed",
                error: error.message,
                failedAt: admin.firestore.FieldValue.serverTimestamp(),
                note: "Failed to send to creating device",
              });

              // Optionally try fallback to all devices
              if (otherTokens.length > 0) {
                console.log(
                  `   ⚠️ Attempting fallback to ${otherTokens.length} other devices`,
                );
                const fallbackMessage = { ...baseMessage, tokens: otherTokens };
                try {
                  const fallbackResponse = await admin
                    .messaging()
                    .sendEachForMulticast(fallbackMessage);
                  console.log(
                    `   ✅ Fallback sent to ${fallbackResponse.successCount} other devices`,
                  );
                  totalSent += fallbackResponse.successCount;
                } catch (fallbackError) {
                  console.error(`   ❌ Fallback also failed:`, fallbackError);
                }
              }
            }
          } else {
            console.log(
              `   ⚠️ No token found for creating device ${creatingDeviceId}`,
            );

            // Send to all devices as fallback
            if (otherTokens.length > 0) {
              console.log(
                `   📱 Sending to ${otherTokens.length} other devices as fallback`,
              );
              const fallbackMessage = { ...baseMessage, tokens: otherTokens };

              try {
                const fallbackResponse = await admin
                  .messaging()
                  .sendEachForMulticast(fallbackMessage);
                console.log(
                  `   ✅ Fallback response: ${fallbackResponse.successCount} sent, ${fallbackResponse.failureCount} failed`,
                );
                totalSent += fallbackResponse.successCount;

                await notification.ref.update({
                  status: "sent",
                  sentAt: admin.firestore.FieldValue.serverTimestamp(),
                  note: "Sent to all available devices (no matching device token)",
                  fcmResponse: {
                    successCount: fallbackResponse.successCount,
                    failureCount: fallbackResponse.failureCount,
                  },
                });

                // Remove invalid tokens
                if (fallbackResponse.failureCount > 0) {
                  fallbackResponse.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                      const failedToken = otherTokens[idx];
                      console.log(
                        `      Removing invalid token: ${failedToken.substring(0, 20)}...`,
                      );
                      db.collection("users")
                        .doc(userId)
                        .collection("fcmTokens")
                        .doc(failedToken)
                        .delete()
                        .catch((err) =>
                          console.log("Error removing token:", err),
                        );
                    }
                  });
                }
              } catch (error) {
                console.error(`   ❌ Error in fallback:`, error);
                await notification.ref.update({
                  status: "failed",
                  error: error.message,
                  failedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            } else {
              console.log(`   ⚠️ No tokens available at all for this user`);
              await notification.ref.update({
                status: "failed",
                note: "No tokens available for this user",
                failedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          }
        }
      }
    }

    console.log(`\n✅ Done. Total notifications sent: ${totalSent}`);
    return totalSent;
  } catch (error) {
    console.error("❌ Error in checkAndSendNotifications:", error);
    throw error;
  }
}

// ============================================
// API ENDPOINTS
// ============================================

// MAIN ENDPOINT for cron-job.org to trigger
app.get("/trigger-notifications", async (req, res) => {
  console.log("🔔 Trigger endpoint called at:", new Date().toISOString());

  // Optional: Add secret key for security
  const secretKey = process.env.CRON_SECRET;
  if (secretKey && req.query.secret !== secretKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await checkAndSendNotifications();
    res.status(200).json({
      success: true,
      sent: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Error in trigger endpoint:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Legacy endpoints (keeping for backward compatibility and debugging)

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

app.get("/users-from-notifications", async (req, res) => {
  console.log("📋 Fetching users from pushNotifications subcollections...");

  try {
    const notificationsSnapshot = await db
      .collectionGroup("pushNotifications")
      .get();

    const userIds = new Set();
    const notifications = [];

    notificationsSnapshot.forEach((doc) => {
      const pathParts = doc.ref.path.split("/");
      const userId = pathParts[1];
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
      sampleNotifications: notifications.slice(0, 5),
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/users-from-tokens", async (req, res) => {
  console.log("📋 Fetching users from fcmTokens subcollections...");

  try {
    const tokensSnapshot = await db.collectionGroup("fcmTokens").get();

    const userIds = new Set();
    const tokens = [];

    tokensSnapshot.forEach((doc) => {
      const pathParts = doc.ref.path.split("/");
      const userId = pathParts[1];
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
      sampleTokens: tokens.slice(0, 5),
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

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
    const collections = await db.listCollections();
    result.collections = collections.map((c) => c.id);

    const usersSnapshot = await db.collection("users").get();
    result.rootUsers = usersSnapshot.size;

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
  res.json({ status: "ok", message: "Notification service running" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Notification service running on port ${PORT}`);
  console.log(`📝 Available endpoints:`);
  console.log(`   🔔 MAIN: /trigger-notifications (call this every minute)`);
  console.log(`   - /users (root collection)`);
  console.log(
    `   - /users-from-notifications (finds users from pushNotifications)`,
  );
  console.log(`   - /users-from-tokens (finds users from fcmTokens)`);
  console.log(`   - /debug-full (comprehensive view)`);
  console.log(`   - /test (list collections)`);
  console.log(`   - /debug-auth (check credentials)`);
  console.log(`   - / (health check)`);
});
