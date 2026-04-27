const fetchFn = global.fetch;

if (typeof fetchFn !== 'function') {
  throw new Error(
    'Global fetch() is not available. Use Node.js 18+ or replace src/roles.js to use an HTTP client.'
  );
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function isRoleMgmtConfigured() {
  // This implementation uses IAS SCIM as a pragmatic, tenant-independent mechanism.
  // If you prefer XSUAA user/group API, swap out this module.
  return Boolean(process.env.IAS_SCIM_URL && process.env.IAS_SCIM_CLIENT_ID && process.env.IAS_SCIM_CLIENT_SECRET);
}

async function iasToken() {
  const url = requiredEnv('IAS_SCIM_TOKEN_URL');
  const clientId = requiredEnv('IAS_SCIM_CLIENT_ID');
  const clientSecret = requiredEnv('IAS_SCIM_CLIENT_SECRET');

  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IAS token failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('IAS token missing access_token');
  return json.access_token;
}

async function scimFindUserIdByLogin(scimBaseUrl, token, userEmailOrLogin) {
  const filter = encodeURIComponent(`userName eq "${userEmailOrLogin}"`);
  const res = await fetchFn(`${scimBaseUrl}/Users?filter=${filter}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SCIM find user failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  const id = json?.Resources?.[0]?.id;
  if (!id) throw new Error(`SCIM user not found for userName=${userEmailOrLogin}`);
  return id;
}

async function scimFindGroupIdByDisplayName(scimBaseUrl, token, groupName) {
  const filter = encodeURIComponent(`displayName eq "${groupName}"`);
  const res = await fetchFn(`${scimBaseUrl}/Groups?filter=${filter}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SCIM find group failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  const id = json?.Resources?.[0]?.id;
  if (!id) throw new Error(`SCIM group not found for displayName=${groupName}`);
  return id;
}

async function scimAddUserToGroup(scimBaseUrl, token, groupId, userId) {
  // Idempotent: SCIM PATCH add is generally safe; server may return 409 if already present.
  const res = await fetchFn(`${scimBaseUrl}/Groups/${groupId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/scim+json'
    },
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        {
          op: 'add',
          path: 'members',
          value: [{ value: userId }]
        }
      ]
    })
  });
  if (res.ok) return;
  if (res.status === 409) return; // already member (common behavior)
  const text = await res.text();
  throw new Error(`SCIM add member failed: ${res.status} ${text}`);
}

async function scimRemoveUserFromGroup(scimBaseUrl, token, groupId, userId) {
  const res = await fetchFn(`${scimBaseUrl}/Groups/${groupId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/scim+json'
    },
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        {
          op: 'remove',
          path: `members[value eq "${userId}"]`
        }
      ]
    })
  });
  if (res.ok) return;
  if (res.status === 404) return;
  const text = await res.text();
  throw new Error(`SCIM remove member failed: ${res.status} ${text}`);
}

async function assignDefaultAdminRoleCollection({ userEmailOrLogin }) {
  if (!isRoleMgmtConfigured()) return;

  const scimBaseUrl = requiredEnv('IAS_SCIM_URL').replace(/\/$/, '');
  const groupName = process.env.DEFAULT_ADMIN_GROUP_NAME || 'S4_Admin';
  const token = await iasToken();

  const userId = await scimFindUserIdByLogin(scimBaseUrl, token, userEmailOrLogin);
  const groupId = await scimFindGroupIdByDisplayName(scimBaseUrl, token, groupName);

  await scimAddUserToGroup(scimBaseUrl, token, groupId, userId);
}

async function revokeDefaultAdminRoleCollection({ userEmailOrLogin }) {
  if (!isRoleMgmtConfigured()) return;

  const scimBaseUrl = requiredEnv('IAS_SCIM_URL').replace(/\/$/, '');
  const groupName = process.env.DEFAULT_ADMIN_GROUP_NAME || 'S4_Admin';
  const token = await iasToken();

  const userId = await scimFindUserIdByLogin(scimBaseUrl, token, userEmailOrLogin);
  const groupId = await scimFindGroupIdByDisplayName(scimBaseUrl, token, groupName);

  await scimRemoveUserFromGroup(scimBaseUrl, token, groupId, userId);
}

module.exports = { assignDefaultAdminRoleCollection, revokeDefaultAdminRoleCollection };

