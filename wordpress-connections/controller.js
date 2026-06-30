// REST endpoints for connecting / managing WordPress sites.
//
//   POST   /api/wordpress-connections           { site_url, username, app_password }
//   GET    /api/wordpress-connections           list user's sites
//   GET    /api/wordpress-connections/:id/categories  list WP categories on the site
//   PATCH  /api/wordpress-connections/:id       set default category
//   PATCH  /api/wordpress-connections/:id/primary  flip primary
//   DELETE /api/wordpress-connections/:id       disconnect

const service = require('./service');
const wpApi = require('./wp_api');

function getUserEmail(req) {
  return (
    req.headers['x-user-email']
    || req.body?.user_email
    || req.query?.user_email
    || ''
  ).toString().trim().toLowerCase();
}

// Connect a new WP site. Validates the app password against the site
// before storing so the user gets immediate feedback if they typed
// something wrong.
async function connect(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const { site_url, username, app_password } = req.body || {};
    if (!site_url) return res.status(400).json({ success: false, message: 'site_url is required' });
    if (!username) return res.status(400).json({ success: false, message: 'username is required' });
    if (!app_password) return res.status(400).json({ success: false, message: 'app_password is required' });

    // App passwords from the WP UI come copy-pasted with spaces every
    // 4 chars (e.g. "abcd 1234 efgh..."). WP accepts both, but stripping
    // makes Basic Auth cleaner.
    const cleanPassword = String(app_password).replace(/\s+/g, '');

    // Validate before storing.
    const info = await wpApi.probeSite({
      siteUrl: site_url,
      username,
      appPassword: cleanPassword,
    });

    const conn = await service.upsertConnection({
      userEmail,
      siteUrl: wpApi.normalizeSiteUrl(site_url),
      siteName: info.siteName,
      username,
      appPassword: cleanPassword,
      siteInfo: {
        description: info.description,
        home: info.home,
        url: info.url,
        wp_user: info.user,
        can_publish: info.canPublish,
      },
    });

    return res.status(200).json({
      success: true,
      connection: {
        id: conn.id,
        site_url: conn.site_url,
        site_name: conn.site_name,
        username: conn.username,
        state: conn.state,
      },
    });
  } catch (err) {
    console.error('wordpress-connections/connect error:', err.message || err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Could not connect to WordPress site.',
    });
  }
}

async function list(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const connections = await service.listConnections({ userEmail });
    return res.status(200).json({ success: true, connections });
  } catch (err) {
    console.error('wordpress-connections/list error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal error' });
  }
}

async function listCategories(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const conn = await service.getConnectionWithToken({ userEmail, connectionId: id });
    if (!conn) return res.status(404).json({ success: false, message: 'Connection not found' });
    const categories = await wpApi.listCategories({
      siteUrl: conn.site_url,
      username: conn.username,
      appPassword: conn.app_password,
    });
    return res.status(200).json({ success: true, categories });
  } catch (err) {
    console.error('wordpress-connections/listCategories error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Could not list categories' });
  }
}

async function patch(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    const { category_id, category_name } = req.body || {};
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    await service.setDefaultCategory({
      userEmail,
      connectionId: id,
      categoryId: category_id ? Number(category_id) : null,
      categoryName: category_name || null,
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Patch failed' });
  }
}

async function setPrimary(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    await service.setPrimaryConnection({ userEmail, connectionId: id });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Failed' });
  }
}

async function destroy(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    await service.disconnect({ userEmail, connectionId: id });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Disconnect failed' });
  }
}

module.exports = { connect, list, listCategories, patch, setPrimary, destroy };
