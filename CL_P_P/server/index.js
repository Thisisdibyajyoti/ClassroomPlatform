// -------------------- Imports --------------------
import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import jwt from "jsonwebtoken";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import fetch from "node-fetch";
import multer from "multer";
import nodemailer from "nodemailer";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";

// -------------------- Setup --------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || "changeme123";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASS,
  },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// -------------------- Database --------------------
let db;
async function initDB() {
  db = await open({
    filename: path.join(__dirname, "classroom.db"),
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT,
      phone TEXT,
      university TEXT,
      college TEXT,
      student_id TEXT,
      role TEXT CHECK(role IN ('student','teacher')),
      password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS classrooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      code TEXT UNIQUE,
      teacher_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(teacher_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS classroom_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      classroom_id INTEGER,
      user_id INTEGER,
      approved INTEGER DEFAULT 1,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(classroom_id) REFERENCES classrooms(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER,
      classroom_id INTEGER,
      type TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lectures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      classroom_id INTEGER,
      teacher_id INTEGER,
      url TEXT,
      type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(classroom_id) REFERENCES classrooms(id),
      FOREIGN KEY(teacher_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      classroom_id INTEGER,
      teacher_id INTEGER,
      url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(classroom_id) REFERENCES classrooms(id),
      FOREIGN KEY(teacher_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      classroom_id INTEGER,
      teacher_id INTEGER,
      filename TEXT,
      original_name TEXT,
      mimetype TEXT,
      size INTEGER,
      url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(classroom_id) REFERENCES classrooms(id),
      FOREIGN KEY(teacher_id) REFERENCES users(id)
    );
  `);

  await db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`
  );
  await db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`
  );
}

// -------------------- Helpers --------------------
function generateToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, college: user.college },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function notifyClassroom(classroomId, message) {
  const members = await db.all(
    `SELECT u.email FROM classroom_members m
     JOIN users u ON u.id=m.user_id
     WHERE m.classroom_id=?`,
    [classroomId]
  );

  for (const m of members) {
    if (m.email) {
      transporter
        .sendMail({
          from: process.env.SMTP_EMAIL,
          to: m.email,
          subject: "Classroom Update",
          text: message,
        })
        .catch(console.error);
    }
  }
}

// -------------------- Auth Routes --------------------
app.post("/api/register", async (req, res) => {
  const {
    name,
    email,
    phone,
    university,
    college,
    student_id,
    role,
    password,
  } = req.body || {};
  if (!name || !role || !password || (!email && !phone)) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (role === "student" && !student_id)
    return res.status(400).json({ error: "Student ID required" });

  try {
    await db.run(
      `INSERT INTO users (name,email,phone,university,college,student_id,role,password)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        name.trim(),
        email?.trim() || null,
        phone?.trim() || null,
        university?.trim() || "",
        college?.trim() || "",
        student_id?.trim() || null,
        role,
        password.trim(),
      ]
    );
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: "User already exists" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, phone, password } = req.body || {};
  const identifier = email || phone;
  if (!identifier || !password)
    return res.status(400).json({ error: "Missing fields" });

  const user = await db.get(
    `SELECT * FROM users WHERE (email=? OR phone=?) AND password=?`,
    [identifier.trim(), identifier.trim(), password.trim()]
  );

  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  res.json({
    token: generateToken(user),
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      email: user.email,
      phone: user.phone,
      college: user.college,
    },
  });
});

app.get("/api/me", auth, async (req, res) => {
  const user = await db.get(
    `SELECT id,name,role,email,phone,university,college,student_id
     FROM users WHERE id=?`,
    [req.user.id]
  );
  res.json({ user });
});

// -------------------- Classroom Routes --------------------
app.post("/api/classrooms", auth, async (req, res) => {
  if (req.user.role !== "teacher")
    return res.status(403).json({ error: "Only teachers can create" });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name required" });

  let code = randomCode();
  while (await db.get("SELECT 1 FROM classrooms WHERE code=?", [code]))
    code = randomCode();

  try {
    await db.run(
      "INSERT INTO classrooms (name, code, teacher_id) VALUES (?,?,?)",
      [name, code, req.user.id]
    );
    const cls = await db.get("SELECT * FROM classrooms WHERE code=?", [code]);
    res.json(cls);
  } catch (e) {
    console.error("Classroom creation failed:", e);
    res.status(400).json({ error: "Failed to create classroom" });
  }
});

app.get("/api/classrooms/mine", auth, async (req, res) => {
  if (req.user.role === "teacher") {
    const rows = await db.all(
      "SELECT * FROM classrooms WHERE teacher_id=? ORDER BY created_at DESC",
      [req.user.id]
    );
    return res.json(rows);
  }

  const rows = await db.all(
    `SELECT c.* FROM classrooms c
     JOIN classroom_members m ON m.classroom_id=c.id
     WHERE m.user_id=? ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

app.post("/api/classrooms/:id/join", auth, async (req, res) => {
  const { id } = req.params;
  const exists = await db.get(
    "SELECT 1 FROM classroom_members WHERE classroom_id=? AND user_id=?",
    [id, req.user.id]
  );
  if (!exists)
    await db.run(
      "INSERT INTO classroom_members (classroom_id,user_id,approved) VALUES (?,?,1)",
      [id, req.user.id]
    );
  res.json({ success: true });
});

app.post("/api/joinByCode", auth, async (req, res) => {
  const { code } = req.body || {};
  const cls = await db.get("SELECT * FROM classrooms WHERE code=?", [code]);
  if (!cls) return res.status(404).json({ error: "Classroom not found" });

  const exists = await db.get(
    "SELECT 1 FROM classroom_members WHERE classroom_id=? AND user_id=?",
    [cls.id, req.user.id]
  );
  if (!exists)
    await db.run(
      "INSERT INTO classroom_members (classroom_id,user_id,approved) VALUES (?,?,1)",
      [cls.id, req.user.id]
    );

  res.json({ success: true, classroom: cls });
});

app.get("/api/classrooms/:id", auth, async (req, res) => {
  const cls = await db.get("SELECT * FROM classrooms WHERE id=?", [
    req.params.id,
  ]);
  if (!cls) return res.status(404).json({ error: "Not found" });
  res.json(cls);
});

app.get("/api/classrooms/:id/members", auth, async (req, res) => {
  const rows = await db.all(
    `SELECT u.id, u.name, u.role, u.college
     FROM classroom_members m
     JOIN users u ON u.id=m.user_id
     WHERE m.classroom_id=?`,
    [req.params.id]
  );
  res.json(rows);
});

// -------------------- Uploads --------------------
const UPLOAD_DIR = path.join(__dirname, "../public/uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const uploadM = multer({ storage });

// List uploads
app.get("/api/uploads", auth, async (req, res) => {
  const classroomId = req.query.classId;
  const rows = classroomId
    ? await db.all("SELECT * FROM uploads WHERE classroom_id=?", [classroomId])
    : await db.all("SELECT * FROM uploads");
  res.json(rows);
});

// Upload with limits + compression
app.post("/api/uploads", auth, uploadM.single("file"), async (req, res) => {
  if (req.user.role !== "teacher")
    return res.status(403).json({ error: "Only teachers can upload" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const { classId, type } = req.body; // type = "lecture" or "quiz"
  const fileSizeMB = req.file.size / (1024 * 1024);

  if (type === "lecture") {
    if (req.file.mimetype.startsWith("video/") && fileSizeMB > 200)
      return res.status(400).json({ error: "Video exceeds 200MB limit" });
    if (!req.file.mimetype.startsWith("video/") && fileSizeMB > 20)
      return res.status(400).json({ error: "File exceeds 20MB limit" });
  } else if (type === "quiz") {
    if (
      req.file.mimetype !== "application/pdf" ||
      fileSizeMB > 20
    ) {
      return res.status(400).json({ error: "Only PDFs ≤20MB allowed" });
    }
  }

  let finalFilename = req.file.filename;
  const filePath = path.join(UPLOAD_DIR, req.file.filename);

  // Compress videos or PDFs
  if (req.file.mimetype.startsWith("video/")) {
    finalFilename = "compressed-" + req.file.filename;
    const outPath = path.join(UPLOAD_DIR, finalFilename);
    await new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .videoCodec("libx264")
        .size("?x720")
        .output(outPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });
    fs.unlinkSync(filePath);
  } else if (req.file.mimetype === "application/pdf") {
    // (basic compression: just keep as is; real compression would use ghostscript)
  }

  const url = "/uploads/" + finalFilename;

  const result = await db.run(
    `INSERT INTO uploads (classroom_id, teacher_id, filename, original_name, mimetype, size, url)
     VALUES (?,?,?,?,?,?,?)`,
    [
      classId,
      req.user.id,
      finalFilename,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      url,
    ]
  );
  const row = await db.get("SELECT * FROM uploads WHERE id=?", result.lastID);
  res.json(row);
});

// Delete upload
app.delete("/api/uploads/:id", auth, async (req, res) => {
  const row = await db.get("SELECT * FROM uploads WHERE id=?", [req.params.id]);
  if (!row) return res.status(404).json({ error: "Not found" });

  const filePath = path.join(UPLOAD_DIR, row.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await db.run("DELETE FROM uploads WHERE id=?", [req.params.id]);
  res.json({ success: true });
});

// -------------------- Chatbot (Gemini AI Guide) --------------------
app.post("/api/chatbot", auth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: message }] }],
        }),
      }
    );

    const data = await response.json();
    const reply =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Sorry, I couldn’t generate a response.";

    res.json({ reply });
  } catch (e) {
    console.error("Gemini error:", e);
    res.status(500).json({ error: "Bot error" });
  }
});

// -------------------- Group Chat (Socket.IO) --------------------
io.on("connection", (socket) => {
  socket.on("joinClassroom", (classroomId) => {
    socket.join(`classroom_${classroomId}`);
  });

  socket.on("sendMessage", async ({ classroomId, senderId, content }) => {
    await db.run(
      "INSERT INTO messages (sender_id, classroom_id, type, content) VALUES (?,?,?,?)",
      [senderId, classroomId, "text", content]
    );

    io.to(`classroom_${classroomId}`).emit("newMessage", {
      senderId,
      content,
      classroomId,
    });
  });
});

// -------------------- Private Messaging --------------------
app.post("/api/privateMessage", auth, async (req, res) => {
  const { to, content } = req.body;
  if (!to || !content)
    return res.status(400).json({ error: "Missing fields" });

  try {
    await transporter.sendMail({
      from: process.env.SMTP_EMAIL,
      to,
      subject: "Private Message from Classroom",
      text: `${req.user.name}: ${content}`,
    });
    res.json({ success: true });
  } catch (e) {
    console.error("Private message error:", e);
    res.status(500).json({ error: "Failed to send" });
  }
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 5000;
initDB().then(() => {
  server.listen(PORT, () =>
    console.log(`✅ Server running at http://localhost:${PORT}`)
  );
});
