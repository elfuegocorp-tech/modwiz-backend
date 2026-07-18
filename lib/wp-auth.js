// Shared by every api/*.js endpoint that needs to know which logged-in
// Modwiz Mastery user is calling — re-checks the same WordPress Application
// Password credentials the app already sends WordPress directly, so this
// backend never has to trust the client's word for who it is.
const WP_BASE_URL = 'https://modwizmastery.com';

async function verifyWpUser(authHeader) {
  if (!authHeader) return null;
  const res = await fetch(`${WP_BASE_URL}/wp-json/wp/v2/users/me`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data.id === 'number' ? { id: data.id, name: data.name } : null;
}

module.exports = { WP_BASE_URL, verifyWpUser };
