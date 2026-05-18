const jwt = require('jsonwebtoken');
const adminService = require('./service');

const jwtSecret = process.env.JWT_SECRET || process.env.SECRET_KEY || 'default_secret';

function safeString(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t || null;
}

function safeInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ----- Auth -----

async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    const admin = await adminService.findAdminByCredentials({ email, password });
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Invalid credentials or not an admin.' });
    }
    const token = jwt.sign(
      { id: admin.id, email: admin.email, is_admin: true },
      jwtSecret,
      { expiresIn: '8h' }
    );
    await adminService.markAdminLogin(admin.email);
    return res.status(200).json({
      success: true,
      token,
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        profile_photo_url: admin.profile_photo_url || null,
      },
    });
  } catch (err) {
    console.error('admin/login error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

function me(req, res) {
  return res.status(200).json({ success: true, admin: req.admin });
}

// ----- Dashboard -----

async function stats(_req, res) {
  try {
    const data = await adminService.getStats();
    return res.status(200).json({ success: true, ...data });
  } catch (err) {
    console.error('admin/stats error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

// ----- Users -----

async function listUsers(req, res) {
  try {
    const users = await adminService.listUsers({ search: safeString(req.query?.search) });
    return res.status(200).json({ success: true, users });
  } catch (err) {
    console.error('admin/listUsers error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function getUser(req, res) {
  try {
    const id = safeInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Missing user id' });
    const user = await adminService.getUserById(id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, user });
  } catch (err) {
    console.error('admin/getUser error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function setUserAdmin(req, res) {
  try {
    const id = safeInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Missing user id' });
    if (req.admin?.id === id && req.body?.is_admin === false) {
      return res.status(400).json({ success: false, message: "You can't revoke your own admin role." });
    }
    const row = await adminService.setUserAdmin({ id, isAdmin: Boolean(req.body?.is_admin) });
    if (!row) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, user: row });
  } catch (err) {
    console.error('admin/setUserAdmin error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function setUserActive(req, res) {
  try {
    const id = safeInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Missing user id' });
    const row = await adminService.setUserActive({ id, active: Boolean(req.body?.active) });
    if (!row) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, user: row });
  } catch (err) {
    console.error('admin/setUserActive error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

// ----- Projects -----

async function listProjects(req, res) {
  try {
    const projects = await adminService.listProjects({
      search: safeString(req.query?.search),
      category: safeString(req.query?.category),
      serviceType: safeString(req.query?.service_type),
      userEmail: safeString(req.query?.user_email),
      status: safeInt(req.query?.status),
    });
    return res.status(200).json({ success: true, projects });
  } catch (err) {
    console.error('admin/listProjects error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function getProject(req, res) {
  try {
    const id = safeInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Missing project id' });
    const project = await adminService.getProjectById(id);
    if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
    return res.status(200).json({ success: true, project });
  } catch (err) {
    console.error('admin/getProject error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function updateProject(req, res) {
  try {
    const id = safeInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Missing project id' });
    const row = await adminService.updateProject({
      id,
      status: safeInt(req.body?.status),
      priority: safeInt(req.body?.priority),
    });
    if (!row) return res.status(404).json({ success: false, message: 'Project not found' });
    return res.status(200).json({ success: true, project: row });
  } catch (err) {
    console.error('admin/updateProject error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function deleteProject(req, res) {
  try {
    const id = safeInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Missing project id' });
    const ok = await adminService.deleteProject(id);
    if (!ok) return res.status(404).json({ success: false, message: 'Project not found' });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('admin/deleteProject error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

// ----- Files -----

async function listFiles(req, res) {
  try {
    const files = await adminService.listFiles({
      search: safeString(req.query?.search),
      category: safeString(req.query?.category),
      serviceType: safeString(req.query?.service_type),
      source: safeString(req.query?.source),
      userEmail: safeString(req.query?.user_email),
    });
    return res.status(200).json({ success: true, files });
  } catch (err) {
    console.error('admin/listFiles error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function deleteFile(req, res) {
  try {
    const id = safeInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Missing file id' });
    const ok = await adminService.deleteFile(id);
    if (!ok) return res.status(404).json({ success: false, message: 'File not found' });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('admin/deleteFile error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

module.exports = {
  login,
  me,
  stats,
  listUsers,
  getUser,
  setUserAdmin,
  setUserActive,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  listFiles,
  deleteFile,
};
