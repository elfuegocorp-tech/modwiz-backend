// Minimal Expo push sender — one POST to Expo's push API, no SDK. The app
// registers device tokens via expo-notifications (services/push-token.ts on
// the app side); any of them can be handed here to reach that device even
// when the app is closed.
//
// Best-effort by contract: every caller treats a failed push as "the user
// will simply find it in the app later", so this logs and returns false
// instead of throwing.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Matches ANDROID_CHANNEL_ID in the app's services/notifications.ts — the
// only channel the app creates with HIGH importance, i.e. the only one
// Android will show as a heads-up banner.
const ANDROID_CHANNEL_ID = 'modwiz-reminders-v2';

function isExpoPushToken(token) {
  return typeof token === 'string' && /^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token);
}

async function sendExpoPush(token, { title, body, data }) {
  if (!isExpoPushToken(token)) return false;
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          to: token,
          title,
          body,
          data: data || {},
          sound: 'default',
          channelId: ANDROID_CHANNEL_ID,
          priority: 'high',
        },
      ]),
    });
    const json = await res.json().catch(() => null);
    const ticket = json && Array.isArray(json.data) ? json.data[0] : null;
    if (!res.ok || !ticket || ticket.status === 'error') {
      console.error('Expo push failed:', res.status, ticket && ticket.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Expo push failed:', err);
    return false;
  }
}

module.exports = { sendExpoPush, isExpoPushToken };
