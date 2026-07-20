const admin = require("firebase-admin");

// Initialize Firebase Admin with service account
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID || "treepreel",
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || "",
  private_key: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL || "",
  client_id: process.env.FIREBASE_CLIENT_ID || "",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CERT_URL || "",
};

let messaging = null;

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  messaging = admin.messaging();
} catch (err) {
  console.warn(
    "⚠️ Firebase init failed (notifications won't work):",
    err.message,
  );
}

/**
 * Send push notification to a single device
 */
async function sendNotification(fcmToken, title, body, data = {}) {
  if (!fcmToken) return null;
  try {
    const message = {
      token: fcmToken,
      notification: { title, body },
      data: { ...data, click_action: "FLUTTER_NOTIFICATION_CLICK" },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "tripreel_notifications",
          icon: "ic_notification",
          color: "#1F8A70",
          ...(data.imageUrl ? { imageUrl: data.imageUrl } : {}),
        },
      },
    };
    // Add image to notification if provided
    if (data.imageUrl) {
      message.notification.imageUrl = data.imageUrl;
    }
    const result = await messaging.send(message);
    return result;
  } catch (err) {
    console.warn("FCM send error:", err.message);
    return null;
  }
}

/**
 * Send notification to multiple devices
 */
async function sendMulticast(fcmTokens, title, body, data = {}) {
  const validTokens = (fcmTokens || []).filter(Boolean);
  if (validTokens.length === 0) return null;
  try {
    const message = {
      tokens: validTokens,
      notification: { title, body },
      data: { ...data, click_action: "FLUTTER_NOTIFICATION_CLICK" },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "tripreel_notifications",
          icon: "ic_notification",
          color: "#1F8A70",
          ...(data.imageUrl ? { imageUrl: data.imageUrl } : {}),
        },
      },
    };
    if (data.imageUrl) {
      message.notification.imageUrl = data.imageUrl;
    }
    const result = await messaging.sendEachForMulticast(message);
    return result;
  } catch (err) {
    console.warn("FCM multicast error:", err.message);
    return null;
  }
}

/**
 * Send notification to a topic (e.g., all users)
 */
async function sendToTopic(topic, title, body, data = {}) {
  try {
    const result = await messaging.send({
      topic,
      notification: { title, body },
      data,
      android: {
        priority: "high",
        notification: { sound: "default", channelId: "tripreel_notifications" },
      },
    });
    return result;
  } catch (err) {
    console.warn("FCM topic error:", err.message);
    return null;
  }
}

module.exports = { sendNotification, sendMulticast, sendToTopic, admin };
