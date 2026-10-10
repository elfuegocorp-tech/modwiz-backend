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

// Same check, plus the caller's WordPress role slugs, for lib/staff.js.
// context=edit is what makes WordPress include `roles`; every member may read
// their own record in that context (record-action.js already does, for
// registered_date). Should a site plugin ever refuse it, the plain check
// answers instead and the caller simply has no staff role — never a 401 for
// someone whose login is fine.
async function verifyWpUserWithRoles(authHeader) {
  if (!authHeader) return null;
  const res = await fetch(`${WP_BASE_URL}/wp-json/wp/v2/users/me?context=edit`, {
    headers: { Authorization: authHeader },
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    const plain = await verifyWpUser(authHeader);
    return plain ? { ...plain, roles: [] } : null;
  }
  const data = await res.json();
  if (typeof data.id !== 'number') return null;
  return { id: data.id, name: data.name, roles: Array.isArray(data.roles) ? data.roles : [] };
}

module.exports = { WP_BASE_URL, verifyWpUser, verifyWpUserWithRoles };
