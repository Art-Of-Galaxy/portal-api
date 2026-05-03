const notionService = require('./service');
const axios = require('axios');
require('dotenv').config();
const { OpenAI } = require('openai');
const jwt = require('jsonwebtoken');
const jwtSecret = process.env.JWT_SECRET || process.env.SECRET_KEY || 'default_secret';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


function describeError(err) {
  if (!err) return 'Internal server error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.error) return typeof err.error === 'string' ? err.error : err.error.message;
  return 'Internal server error';
}

function getRequestEmail(req) {
  const rawFallback = (
    req.headers?.['x-user-email'] ||
    req.body?.user_email ||
    ''
  );
  const fallbackEmail = typeof rawFallback === 'string' ? rawFallback.trim() : '';
  const authHeader = req.headers?.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) return fallbackEmail;

  try {
    const decoded = jwt.verify(token, jwtSecret);
    const rawEmail = decoded.email || decoded.user_email || fallbackEmail || '';
    return typeof rawEmail === 'string' ? rawEmail.trim() : fallbackEmail;
  } catch {
    return fallbackEmail;
  }
}

let get_projects = async (req, res) => {
  try {
    const userEmail = getRequestEmail(req);
    req.body = {
      ...(req.body || {}),
      user_email: userEmail,
    };

    // const NOTION_TOKEN = "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";
    // console.log('NOTION_TOKEN:', NOTION_TOKEN);

    // const DATABASE_ID = '1d9d5b45-9598-81d6-b605-f5d0c94d97e7';

    // const response = await axios.post(
    //   `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
    //   {}, // body — empty to fetch all
    //   {
    //     headers: {
    //       'Authorization': `Bearer ${NOTION_TOKEN}`,
    //       'Notion-Version': '2022-06-28',
    //       'Content-Type': 'application/json',
    //     },
    //   }
    // );

    // const projects = response.data.results.map((page) => {
    //   const props = page.properties;
    //   return {
    //     id: page.id,
    //     name: props["Project name"]?.title?.[0]?.text?.content || "Untitled",
    //     ownerId: props.Owner?.people?.[0]?.id || "Unassigned",
    //     status: props.Status?.status?.name || "Unknown",
    //     priority: props.Priority?.select?.name || "None",
    //     completion: props.Completion?.rollup?.number || 0,
    //     startDate: props.Dates?.date?.start || null,
    //     endDate: props.Dates?.date?.end || null,
    //     summary: props.Summary?.rich_text?.[0]?.text?.content || "",
    //     tasks: props.Tasks?.relation?.map((t) => t.id) || [],
    //     isBlocking: props["Is Blocking"]?.relation?.map((b) => b.id) || [],
    //     blockedBy: props["Blocked By"]?.relation?.map((b) => b.id) || [],
    //     url: page.url
    //   };
    // });
    const response = await notionService.get_projects(req, res);
    const rows = response.data || [];
    const projects = rows.map((page) => ({
      id: page.id,
      project_name: page.project_name,
      name: page.project_name,
      ownerId: page.name,
      status: page.status,
      status_label: page.status_label,
      priority: page.priority,
      priority_label: page.priority_label,
      startDate: page.created_date,
      created_date: page.created_date,
      endDate: page.due_date,
      due_date: page.due_date,
      tags: page.tags,
      category: page.category,
      service_type: page.service_type,
      model: page.model,
      user_email: page.user_email,
    }));

    res.status(200).json({ success: true, projects });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ success: false, message: describeError(error) });
  }
};
let add_project = async (req, res) => {
  try {
    const userEmail = getRequestEmail(req);
    req.body = {
      ...(req.body || {}),
      user_email: userEmail,
    };

    console.log('received data:', req.body);

    const {
      name,
      ownerId,
      status,
      priority,
      startDate,
      endDate,
      summary
    } = req.body;

    const response = await notionService.add_project(req, res);

    res.status(201).json({
      message: 'Project added successfully',
      project: response.data,
      success: true
    });

  } catch (error) {
    console.error('Error adding project:', error.response?.data || error.message);
    res.status(500).json({ message: 'Internal server error', error: error.response?.data });
  }
};
let generateLogo = async (req, res) => {
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: `Create a modern, minimalist logo for a technology company. The design should feature a geometric, upward-pointing arrow symbol made from three stacked chevrons. Use a smooth gradient that transitions from blue to purple. Below the icon, display the company name "Clap Logic" in bold, dark navy sans-serif font, and the tagline "All at under one roof" in a lighter weight. Use an off-white background and keep the layout balanced, clean, and professional. The logo should feel innovative, trustworthy, and suitable for digital and print.`,
      n: 1,
      size: "1024x1024",
      response_format: "url",
    });

    const imageUrl = response.data[0].url;
    res.status(200).json({
      message: 'Generated logo successfully',
      imageurl: imageUrl,
      success: true
    });
    return imageUrl;
  } catch (err) {
    console.error("Error generating logo:", err);
  }
}

// controllers/project.controller.js
let get_project_priority = async (req, res) => {
  try {
    const result = await notionService.get_project_priority();

    if (result.success && result.data.length > 0) {
      console.log('Project priorities fetched successfully');
      return res.status(200).json({ success: true, data: result.data });
    }

    console.log('No project priorities found');
    return res.status(404).json({ success: false, message: 'No project priorities found' });
  } catch (error) {
    console.error('Error fetching project priority:', error?.error || error.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

let get_project_status = async (req, res) => {
  try {
    const result = await notionService.get_project_status();

    if (result.success && result.data.length > 0) {
      console.log('Project statuses fetched successfully');
      return res.status(200).json({ success: true, data: result.data });
    }

    console.log('No project statuses found');
    return res.status(404).json({ success: false, message: 'No project statuses found' });
  } catch (error) {
    console.error('Error fetching project status:', error?.error || error.message);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
let add_task = async (req, res) => {
  try {
    const response = await notionService.add_task(req, res);
    if (response.success) {
      res.status(201).json({
        message: 'Task added successfully',
        task: response.data,
        success: true
      });
    } else {
      res.status(400).json({ message: response.message });
    }
  } catch (error) {
    console.error('Error adding task:', error.response?.data || error.message);
    res.status(500).json({ message: 'Internal server error', error: error.response?.data });
  }
};

let get_task = async (req, res) => {
  try {
    const response = await notionService.get_task(req, res);
    if (response.success) {
      res.status(200).json({
        message: 'Tasks fetched successfully',
        tasks: response.data,
        success: true
      });
    } else {
      res.status(404).json({ message: response.message });
    }
  } catch (error) {
    console.error('Error fetching tasks:', error.response?.data || error.message);
    res.status(500).json({ message: 'Internal server error', error: error.response?.data });
  }
};

let save_file = async (req, res) => {
  try {
    const response = await notionService.save_file(req, res);
    if (response.success) {
      res.status(201).json({
        message: 'File saved successfully',
        file: response.data,
        success: true
      });
    } else {
      res.status(400).json({ message: response.message });
    }
  } catch (error) {
    console.error('Error saving file:', error.response?.data || error.message);
    res.status(500).json({ message: 'Internal server error', error: error.response?.data });
  }
};
let get_files = async (req, res) => {
  try {
    const response = await notionService.get_files(req, res);
    if (response.success) {
      res.status(200).json({
        message: 'Files fetched successfully',
        files: response.data,
        success: true
      });
    } else {
      res.status(404).json({ message: response.message });
    }
  } catch (error) {
    console.error('Error fetching files:', error.response?.data || error.message);
    res.status(500).json({ message: 'Internal server error', error: error.response?.data });
  }
};
let get_project_by_id = async (req, res) => {
  try {
    const id = (req.body && req.body.id) || req.params.id;
    const userEmail = getRequestEmail(req);
    if (!id) return res.status(400).json({ success: false, message: 'Missing project id' });

    const row = await notionService.get_project_by_id({ id, userEmail });
    if (!row) return res.status(404).json({ success: false, message: 'Project not found' });

    return res.status(200).json({ success: true, project: row });
  } catch (err) {
    console.error('Error fetching project by id:', err);
    return res.status(500).json({ success: false, message: describeError(err) });
  }
};

let delete_project = async (req, res) => {
  try {
    const id = req.body?.id || req.params.id;
    const userEmail = req.body?.user_email;
    if (!id) return res.status(400).json({ success: false, message: 'Missing project id' });
    if (!userEmail) return res.status(400).json({ success: false, message: 'Missing user email' });

    const ok = await notionService.delete_project({ id, userEmail });
    if (!ok) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error deleting project:', err);
    return res.status(500).json({ success: false, message: describeError(err) });
  }
};

module.exports = {
  get_projects,
  add_project,
  generateLogo,
  get_project_status,
  get_project_priority,
  add_task,
  get_task,
  save_file,
  get_files,
  get_project_by_id,
  delete_project,
};
