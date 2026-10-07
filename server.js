#!/usr/bin/env node
/* =========================================================
   EXAMGUARD — OFFLINE / LOCAL NETWORK SERVER
   ---------------------------------------------------------
   Run this on the TEACHER's computer. It:
     - serves the ExamGuard app (index.html / style.css / script.js)
     - stores classes, questions, exams and student attempts in
       a local file (examguard_data.json) next to this script
     - is the shared "server" that every student phone talks to
       over the classroom Wi-Fi / router — no internet required
       by anyone once everyone is on the same network.

   SETUP (one time, needs internet):
     1. Install Node.js (https://nodejs.org) on the teacher's
        computer.
     2. Change TEACHER_PASSWORD below to a password only you know.

   EVERY CLASS:
     1. Connect the teacher's computer to the classroom Wi-Fi /
        router (no internet needed on that network).
     2. Run:  node server.js
     3. The terminal prints the address(es) to share with
        students, e.g. http://192.168.1.23:8080
     4. Teacher opens that address (or http://localhost:8080)
        and signs in with TEACHER_PASSWORD.
     5. Students open the SAME address in their phone's browser
        and enter the class code — nothing to install.

   No npm install, no external packages — only Node's built-ins,
   so this works even with zero internet access in the room.
   ========================================================= */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

/* =========================================================
   SETTINGS — change these before your first class
   ========================================================= */
const PORT = 8080;
const TEACHER_PASSWORD = "changeme"; // <-- CHANGE THIS

const DATA_FILE = path.join(__dirname, "examguard_data.json");
const PUBLIC_DIR = __dirname;


/* =========================================================
   PERSISTENCE
   ========================================================= */

function loadData() {

  try {

    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    return {
      classes: raw.classes || [],
      questions: raw.questions || [],
      exams: raw.exams || [],
      attempts: raw.attempts || []
    };

  } catch (error) {

    return { classes: [], questions: [], exams: [], attempts: [] };

  }

}

let db = loadData();
let saveTimer = null;

function saveData() {

  clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {

    fs.writeFile(DATA_FILE, JSON.stringify(db), () => {});

  }, 150);

}


/* =========================================================
   TEACHER SESSIONS (simple bearer tokens, reset on restart)
   ========================================================= */

const tokens = new Set();

function newToken() {

  const t = crypto.randomBytes(24).toString("hex");

  tokens.add(t);

  return t;

}

function isTeacher(req) {

  const header = req.headers["authorization"] || "";

  const match = /^Bearer (.+)$/.exec(header);

  return !!(match && tokens.has(match[1]));

}


/* =========================================================
   EXAM LOGIC
   (mirrors supabase_setup.sql, so online and offline mode
   behave identically)
   ========================================================= */

function nowISO() {

  return new Date().toISOString();

}

function norm(value) {

  return String(value == null ? "" : value)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

}

function scoreAttempt(answers, key) {

  answers = answers || [];
  key = key || [];

  let total = 0;

  key.forEach((entry, index) => {

    if (!entry) return;

    const given = answers[index];

    let ok;

    if (entry.t === "IDENTIFICATION") {

      const alts = String(entry.c || "").split(";");

      ok =
        alts.some(
          alt => norm(alt) !== "" && norm(alt) === norm(given)
        );

    } else {

      ok = given === entry.c;

    }

    if (ok) total += (entry.p || 0);

  });

  return total;

}

function finalizeAttempt(attempt, status, reason) {

  if (attempt.status !== "WAITING" && attempt.status !== "ANSWERING") {

    return;

  }

  attempt.status = status;
  attempt.reason = reason;
  attempt.score = scoreAttempt(attempt.answers, attempt.key);

  if (status === "SUBMITTED") attempt.submitted_at = nowISO();
  if (status === "EXITED") attempt.exited_at = nowISO();

}

function sweep() {

  const now = Date.now();

  db.attempts.forEach(attempt => {

    if (
      attempt.status === "ANSWERING" &&
      now - new Date(attempt.last_seen).getTime() > 45000
    ) {

      attempt.status = "EXITED";
      attempt.reason = "SIGNAL_LOST";
      attempt.exited_at = nowISO();
      attempt.score = scoreAttempt(attempt.answers, attempt.key);

    }

  });

  db.attempts =
    db.attempts.filter(attempt =>
      !(
        attempt.status === "WAITING" &&
        now - new Date(attempt.last_seen).getTime() > 120000
      )
    );

}

function findExam(id) {

  return db.exams.find(e => e.id === id);

}

function findAttempt(id) {

  return db.attempts.find(a => a.id === id);

}

function questionsForClass(classID) {

  return db.questions.filter(q => q.class_id === classID);

}

function shuffle(list) {

  for (let i = list.length - 1; i > 0; i--) {

    const j = Math.floor(Math.random() * (i + 1));

    [list[i], list[j]] = [list[j], list[i]];

  }

  return list;

}


/* ---------- teacher-only RPCs ---------- */

function rpc_is_teacher(req) {

  return { data: isTeacher(req) };

}

function rpc_teacher_sweep(req) {

  if (!isTeacher(req)) return { status: 403, error: { message: "not allowed" } };

  sweep();
  saveData();

  return { data: { ok: true } };

}

function rpc_teacher_end_attempt(req, params) {

  if (!isTeacher(req)) return { status: 403, error: { message: "not allowed" } };

  const attempt = findAttempt(params.p_attempt_id);

  if (attempt) finalizeAttempt(attempt, "EXITED", "TEACHER");

  saveData();

  return { data: { ok: true } };

}


/* ---------- student-facing RPCs (no auth, matches anon grants) ---------- */

function pollResult(attempt) {

  const exam = findExam(attempt.exam_id) || {};

  const questions = questionsForClass(exam.class_id) || [];

  const questionCount = questions.length;

  const totalPoints =
    questions.reduce((sum, q) => sum + (q.points || 0), 0);

  const waitingCount =
    db.attempts.filter(
      a => a.exam_id === exam.id && a.status === "WAITING"
    ).length;

  if (attempt.status === "WAITING" || attempt.status === "ANSWERING") {

    attempt.last_seen = nowISO();

  }

  let remainingSeconds;

  if (attempt.status === "ANSWERING") {

    const end =
      new Date(attempt.started_at).getTime() +
      (exam.duration || 0) * 60000;

    remainingSeconds =
      Math.max(0, Math.ceil((end - Date.now()) / 1000));

  }

  return {
    status: attempt.status,
    reason: attempt.reason || null,
    exam_status: exam.status,
    started: !!exam.started_at,
    title: exam.title,
    duration: exam.duration,
    randomize: exam.randomize,
    question_count: questionCount,
    total_points: totalPoints,
    waiting_count: waitingCount,
    remaining_seconds: remainingSeconds,
    score: attempt.score,
    total: attempt.total
  };

}

function rpc_poll_attempt(req, params) {

  sweep();

  const attempt = findAttempt(params.p_attempt_id);

  if (!attempt) return { data: { status: "REMOVED" } };

  const result = pollResult(attempt);

  saveData();

  return { data: result };

}

function rpc_join_exam(req, params) {

  sweep();

  const code = String(params.p_code || "").trim().toUpperCase();

  const exam = db.exams.find(e => e.code === code);

  if (!exam) return { data: { error: "not_found" } };
  if (exam.status !== "OPEN") return { data: { error: "closed" } };

  const name = String(params.p_name || "").trim().slice(0, 80);

  if (!name) return { data: { error: "name_required" } };

  const questionCount = questionsForClass(exam.class_id).length;

  if (questionCount === 0) return { data: { error: "no_questions" } };

  const clean = value => {
    const v = String(value || "").trim();
    return v === "" ? null : v;
  };

  const attempt = {
    id: crypto.randomUUID(),
    exam_id: exam.id,
    student_name: name,
    student_sex: clean(params.p_sex),
    student_surname: clean(params.p_surname),
    student_given_name: clean(params.p_given_name),
    student_middle_initial: clean(params.p_middle_initial),
    student_suffix: clean(params.p_suffix),
    status: "WAITING",
    reason: null,
    question_ids: [],
    answers: [],
    paper: null,
    key: null,
    score: 0,
    total: 0,
    joined_at: nowISO(),
    started_at: null,
    submitted_at: null,
    exited_at: null,
    last_seen: nowISO()
  };

  db.attempts.push(attempt);

  const result = pollResult(attempt);

  saveData();

  return { data: Object.assign({}, result, { attempt_id: attempt.id }) };

}

function rpc_start_attempt(req, params) {

  const attempt = findAttempt(params.p_attempt_id);

  if (!attempt) return { data: { error: "removed" } };

  const exam = findExam(attempt.exam_id) || {};

  if (attempt.status === "ANSWERING") {

    const end =
      new Date(attempt.started_at).getTime() +
      (exam.duration || 0) * 60000;

    return {
      data: {
        ok: true,
        paper: attempt.paper,
        answers: attempt.answers,
        remaining_seconds:
          Math.max(0, Math.ceil((end - Date.now()) / 1000))
      }
    };

  }

  if (attempt.status !== "WAITING") return { data: { error: "ended" } };
  if (exam.status !== "OPEN") return { data: { error: "closed" } };
  if (!exam.started_at) return { data: { error: "not_started" } };

  let questions = questionsForClass(exam.class_id).slice();

  questions.sort((a, b) =>
    new Date(a.created_at) - new Date(b.created_at) ||
    String(a.id).localeCompare(String(b.id))
  );

  if (exam.randomize) shuffle(questions);

  if (questions.length === 0) return { data: { error: "no_questions" } };

  const paper =
    questions.map(q => ({
      id: q.id,
      text: q.text,
      choices: q.choices,
      points: q.points,
      type: q.qtype || "MULTIPLE_CHOICE"
    }));

  const key =
    questions.map(q => ({
      c: q.correct,
      p: q.points,
      t: q.qtype || "MULTIPLE_CHOICE"
    }));

  const ids = questions.map(q => q.id);

  const total = questions.reduce((sum, q) => sum + (q.points || 0), 0);

  const answers = new Array(questions.length).fill(null);

  attempt.status = "ANSWERING";
  attempt.paper = paper;
  attempt.key = key;
  attempt.question_ids = ids;
  attempt.answers = answers;
  attempt.total = total;
  attempt.score = 0;
  attempt.started_at = nowISO();
  attempt.last_seen = nowISO();

  saveData();

  return {
    data: {
      ok: true,
      paper,
      answers,
      remaining_seconds: (exam.duration || 0) * 60
    }
  };

}

function rpc_save_answer(req, params) {

  const attempt = findAttempt(params.p_attempt_id);

  if (!attempt) return { data: { status: "REMOVED" } };
  if (attempt.status !== "ANSWERING") return { data: { status: attempt.status } };

  const exam = findExam(attempt.exam_id) || {};

  const deadline =
    new Date(attempt.started_at).getTime() +
    (exam.duration || 0) * 60000 +
    5000;

  if (Date.now() > deadline) {

    return { data: { status: "ANSWERING", error: "time_up" } };

  }

  const index = params.p_index;

  if (
    typeof index !== "number" ||
    index < 0 ||
    index >= attempt.answers.length
  ) {

    return { data: { status: "ANSWERING", error: "invalid" } };

  }

  const type =
    (attempt.key[index] && attempt.key[index].t) || "MULTIPLE_CHOICE";

  const raw = params.p_answer;
  let value;

  if (type === "IDENTIFICATION") {

    const trimmed = String(raw || "").trim();

    value = trimmed === "" ? null : trimmed.slice(0, 200);

  } else if (type === "TRUE_FALSE") {

    if (raw !== "A" && raw !== "B") {

      return { data: { status: "ANSWERING", error: "invalid" } };

    }

    value = raw;

  } else {

    if (!["A", "B", "C", "D"].includes(raw)) {

      return { data: { status: "ANSWERING", error: "invalid" } };

    }

    value = raw;

  }

  attempt.answers[index] = value;
  attempt.last_seen = nowISO();

  saveData();

  return { data: { status: "ANSWERING", ok: true } };

}

function rpc_submit_attempt(req, params) {

  const attempt = findAttempt(params.p_attempt_id);

  if (!attempt) return { data: { status: "REMOVED" } };

  if (attempt.status === "ANSWERING") {

    finalizeAttempt(
      attempt,
      "SUBMITTED",
      params.p_reason === "TIME_UP" ? "TIME_UP" : "SUBMITTED"
    );

  }

  saveData();

  return {
    data: {
      status: attempt.status,
      reason: attempt.reason,
      score: attempt.score,
      total: attempt.total
    }
  };

}

function rpc_leave_attempt(req, params) {

  const attempt = findAttempt(params.p_attempt_id);

  if (!attempt) return { data: { ok: true } };

  if (attempt.status === "WAITING") {

    db.attempts = db.attempts.filter(a => a.id !== attempt.id);

  } else if (attempt.status === "ANSWERING") {

    finalizeAttempt(attempt, "EXITED", "LEFT_SCREEN");

  }

  saveData();

  return { data: { ok: true } };

}

const RPCS = {
  is_teacher: rpc_is_teacher,
  teacher_sweep: rpc_teacher_sweep,
  teacher_end_attempt: rpc_teacher_end_attempt,
  poll_attempt: rpc_poll_attempt,
  join_exam: rpc_join_exam,
  start_attempt: rpc_start_attempt,
  save_answer: rpc_save_answer,
  submit_attempt: rpc_submit_attempt,
  leave_attempt: rpc_leave_attempt
};


/* =========================================================
   TABLE CRUD  (classes / questions / exams — teacher only)
   ========================================================= */

const TABLES = ["classes", "questions", "exams"];

function cascadeDeleteExam(examID) {

  db.attempts = db.attempts.filter(a => a.exam_id !== examID);

}

function cascadeDeleteClass(classID) {

  const examIDs =
    db.exams.filter(e => e.class_id === classID).map(e => e.id);

  db.questions = db.questions.filter(q => q.class_id !== classID);
  db.exams = db.exams.filter(e => e.class_id !== classID);

  examIDs.forEach(cascadeDeleteExam);

}


/* =========================================================
   HTTP PLUMBING
   ========================================================= */

function send(res, status, body) {

  const json = JSON.stringify(body === undefined ? {} : body);

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json)
  });

  res.end(json);

}

function readBody(req) {

  return new Promise((resolve, reject) => {

    const chunks = [];
    let size = 0;

    req.on("data", chunk => {

      size += chunk.length;

      if (size > 2 * 1024 * 1024) {

        reject(new Error("body too large"));
        req.destroy();
        return;

      }

      chunks.push(chunk);

    });

    req.on("end", () => {

      if (!chunks.length) return resolve({});

      try {

        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));

      } catch (error) {

        resolve({});

      }

    });

    req.on("error", reject);

  });

}

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function serveStatic(res, urlPath) {

  let file = urlPath === "/" ? "/index.html" : urlPath;

  file = file.split("?")[0];

  const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, "");

  const full = path.join(PUBLIC_DIR, safe);

  if (!full.startsWith(PUBLIC_DIR)) {

    res.writeHead(403);
    res.end();
    return;

  }

  fs.readFile(full, (error, buf) => {

    if (error) {

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;

    }

    const ext = path.extname(full);
    let body = buf;

    /* marks the page as offline mode so script.js knows to talk
       to THIS server instead of Supabase */
    if (ext === ".html") {

      body = Buffer.from(
        buf.toString("utf8").replace(
          '<script src="script.js"></script>',
          '<script>window.EXAMGUARD_OFFLINE = true;</script>\n' +
          '  <script src="script.js"></script>'
        ),
        "utf8"
      );

    }

    res.writeHead(200, {
      "Content-Type":
        (MIME[ext] || "application/octet-stream") +
        (ext === ".html" ? "; charset=utf-8" : "")
    });

    res.end(body);

  });

}

const server = http.createServer(async (req, res) => {

  let url;

  try {

    url = new URL(req.url, "http://" + req.headers.host);

  } catch (error) {

    res.writeHead(400);
    res.end();
    return;

  }

  const p = url.pathname;

  try {

    if (p === "/api/login" && req.method === "POST") {

      const body = await readBody(req);

      if (body.password === TEACHER_PASSWORD) {

        return send(res, 200, { token: newToken() });

      }

      return send(res, 401, { error: { message: "wrong_password" } });

    }

    if (p === "/api/logout" && req.method === "POST") {

      const header = req.headers["authorization"] || "";
      const match = /^Bearer (.+)$/.exec(header);

      if (match) tokens.delete(match[1]);

      return send(res, 200, { ok: true });

    }

    if (p.startsWith("/api/rpc/") && req.method === "POST") {

      const name = p.slice("/api/rpc/".length);
      const fn = RPCS[name];

      if (!fn) return send(res, 404, { error: { message: "unknown_rpc" } });

      const body = await readBody(req);
      const result = fn(req, body) || {};

      if (result.error) {

        return send(res, result.status || 400, { error: result.error });

      }

      return send(res, 200, result.data);

    }

    if (p === "/api/attempts" && req.method === "GET") {

      if (!isTeacher(req)) {

        return send(res, 401, { error: { message: "not allowed" } });

      }

      const rows =
        db.attempts
          .slice()
          .sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at))
          .slice(-1000);

      return send(res, 200, rows);

    }

    const tableMatch =
      /^\/api\/table\/([a-z]+)(?:\/([^/]+))?$/.exec(p);

    if (tableMatch) {

      const table = tableMatch[1];
      const id = tableMatch[2] ? decodeURIComponent(tableMatch[2]) : null;

      if (!isTeacher(req)) {

        return send(res, 401, { error: { message: "not allowed" } });

      }

      if (req.method === "GET" && !id && TABLES.includes(table)) {

        const rows =
          db[table]
            .slice()
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        return send(res, 200, rows);

      }

      if (req.method === "POST" && !id && TABLES.includes(table)) {

        const body = await readBody(req);

        (body.rows || []).forEach(row => db[table].push(row));

        saveData();

        return send(res, 200, { ok: true });

      }

      if (req.method === "PATCH" && id && TABLES.includes(table)) {

        const body = await readBody(req);
        const row = db[table].find(r => r.id === id);

        if (row) Object.assign(row, body);

        saveData();

        return send(res, 200, { ok: true });

      }

      if (
        req.method === "DELETE" &&
        id &&
        (TABLES.includes(table) || table === "attempts")
      ) {

        const before = db[table].length;

        db[table] = db[table].filter(r => r.id !== id);

        const deleted = db[table].length < before;

        if (table === "classes" && deleted) cascadeDeleteClass(id);
        if (table === "exams" && deleted) cascadeDeleteExam(id);

        saveData();

        return send(res, 200, deleted ? [{ id }] : []);

      }

      return send(res, 404, { error: { message: "not_found" } });

    }

    if (req.method === "GET") return serveStatic(res, p);

    send(res, 404, { error: { message: "not_found" } });

  } catch (error) {

    console.error(error);
    send(res, 500, { error: { message: "server_error" } });

  }

});

/* cleans up idle waiting rooms / dropped connections even when
   nobody happens to be polling right at that moment */
setInterval(() => {

  sweep();
  saveData();

}, 15000);

function localIPs() {

  const nets = os.networkInterfaces();
  const out = [];

  Object.values(nets).forEach(list => {

    (list || []).forEach(entry => {

      if (entry.family === "IPv4" && !entry.internal) {

        out.push(entry.address);

      }

    });

  });

  return out;

}

server.listen(PORT, () => {

  console.log("");
  console.log("=================================================");
  console.log("  EXAMGUARD — offline server is running");
  console.log("=================================================");
  console.log("");
  console.log("On THIS computer, open:");
  console.log("  http://localhost:" + PORT);
  console.log("");

  const ips = localIPs();

  if (ips.length) {

    console.log("On STUDENT phones (same Wi-Fi/router, no internet needed):");
    ips.forEach(ip => console.log("  http://" + ip + ":" + PORT));

  } else {

    console.log(
      "Could not detect a local network address. Connect this " +
      "computer to the classroom Wi-Fi / router and restart."
    );

  }

  console.log("");
  console.log("Teacher password: " + TEACHER_PASSWORD);

  if (TEACHER_PASSWORD === "changeme") {

    console.log(
      "  >> Change TEACHER_PASSWORD at the top of server.js before class! <<"
    );

  }

  console.log("");

});
