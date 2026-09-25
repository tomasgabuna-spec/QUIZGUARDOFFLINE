/* =========================================================
   EXAMGUARD
   Secure Examination and Monitoring System
   Works in two modes:
     - ONLINE:  all devices share one Supabase database
                (needs internet on every device)
     - OFFLINE: the teacher's computer runs server.js and acts
                as the shared server over the classroom Wi-Fi /
                router. No internet needed by anyone once the
                Wi-Fi is up. Students open the teacher's local
                address in their phone's browser - nothing to
                install. See OFFLINE_SETUP.md.
   Which mode is active is decided by HOW the page was opened:
   server.js marks the page it serves, so opening the app from
   the local server is always OFFLINE, and opening the hosted /
   static copy is always ONLINE. There is nothing to configure
   here for offline mode.
   ========================================================= */


/* =========================================================
   SETTINGS
   Fill in the first two lines (see SETUP.md).
   Supabase dashboard -> Project Settings -> API
   Use the "anon public" key. NEVER use the service_role key.
   ========================================================= */

const CONFIG = {

  SUPABASE_URL: "https://sttlkmsjtetyesxmvkkt.supabase.co",

  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN0dGxrbXNqdGV0eWVzeG12a2t0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5NzA5ODUsImV4cCI6MjEwNTU0Njk4NX0.DlhdH0ohAhgS5Knp6TJEi27ge8pyOVv_u_PQR6waIks",

  /* how often (milliseconds) devices check in with the server */
  STUDENT_POLL_MS: 3000,
  TEACHER_POLL_MS: 3000,

  /* If the exam timer stops ticking for longer than this, the phone
     was asleep or frozen, so the exam is treated as "left the screen". */
  RESUME_GAP_MS: 8000,

  /* Also end the exam when the window loses focus (split-screen,
     floating windows...). Off by default because it can be triggered
     by accident. Minimizing / switching apps / locking the phone are
     always detected. */
  END_ON_WINDOW_BLUR: false

};


function isConfigured() {

  return (
    typeof CONFIG.SUPABASE_URL === "string" &&
    CONFIG.SUPABASE_URL.startsWith("https://") &&
    !CONFIG.SUPABASE_URL.includes("YOUR-PROJECT") &&
    typeof CONFIG.SUPABASE_ANON_KEY === "string" &&
    CONFIG.SUPABASE_ANON_KEY.length > 20 &&
    !CONFIG.SUPABASE_ANON_KEY.includes("YOUR-ANON")
  );

}


/* true only when this page was served by server.js (offline / LAN mode) */
const OFFLINE_MODE = !!window.EXAMGUARD_OFFLINE;

const sb =
  !OFFLINE_MODE && isConfigured() && window.supabase
    ? window.supabase.createClient(
        CONFIG.SUPABASE_URL,
        CONFIG.SUPABASE_ANON_KEY
      )
    : null;


const SERVER_UNAVAILABLE =
  OFFLINE_MODE
    ? "The exam server is not available. " +
      "Ask your teacher to check server.js."
    : "The exam server is not available. " +
      "Check the Supabase setup or your internet connection.";


/* =========================================================
   BACKEND
   In OFFLINE_MODE every call below goes to the local server
   (same address the page was loaded from) instead of Supabase.
   Every method returns { data, error } just like the Supabase
   client, so the rest of the app does not need to know which
   mode it is running in.
   ========================================================= */

/* kept signed in across page reloads on this device */
let localToken =
  OFFLINE_MODE
    ? (localStorage.getItem("examguard_local_token") || null)
    : null;

async function localFetch(path, options) {

  options = options || {};

  const headers =
    Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {},
      localToken ? { Authorization: "Bearer " + localToken } : {}
    );

  let res;

  try {

    res =
      await fetch(
        path,
        Object.assign({}, options, { headers })
      );

  } catch (error) {

    return { data: null, error: { message: "network_error" } };

  }

  let body = null;

  try {

    body = await res.json();

  } catch (error) {

    /* empty body */

  }

  if (!res.ok) {

    return {
      data: null,
      error: (body && body.error) || { message: "request_failed" }
    };

  }

  return { data: body, error: null };

}


const api = {

  ready: OFFLINE_MODE ? true : !!sb,

  auth: {

    async getSession() {

      if (OFFLINE_MODE) {

        return { data: { session: localToken ? {} : null } };

      }

      return sb.auth.getSession();

    },

    async signInWithPassword({ email, password }) {

      if (OFFLINE_MODE) {

        const { data, error } =
          await localFetch("/api/login", {
            method: "POST",
            body: JSON.stringify({ password })
          });

        if (error) {

          return {
            error: { message: "Incorrect password." }
          };

        }

        localToken = data.token;

        localStorage.setItem(
          "examguard_local_token",
          localToken
        );

        return { error: null };

      }

      return sb.auth.signInWithPassword({ email, password });

    },

    async signOut() {

      if (OFFLINE_MODE) {

        localFetch("/api/logout", { method: "POST" })
          .catch(() => {});

        localToken = null;

        localStorage.removeItem("examguard_local_token");

        return { error: null };

      }

      return sb.auth.signOut();

    }

  },

  async rpc(name, params) {

    if (OFFLINE_MODE) {

      return localFetch("/api/rpc/" + name, {
        method: "POST",
        body: JSON.stringify(params || {})
      });

    }

    return sb.rpc(name, params);

  },

  async selectAll(table) {

    if (OFFLINE_MODE) {

      return localFetch("/api/table/" + table);

    }

    const { data, error } =
      await sb
        .from(table)
        .select("*")
        .order("created_at", { ascending: true });

    return { data, error };

  },

  async selectAttempts() {

    if (OFFLINE_MODE) {

      /* the local server already returns them oldest-first */
      return localFetch("/api/attempts");

    }

    const { data, error } =
      await sb
        .from("attempts")
        .select(ATTEMPT_COLUMNS)
        .order("joined_at", { ascending: false })
        .limit(1000);

    return { data: data ? data.reverse() : data, error };

  },

  async insertRows(table, rows) {

    if (!rows.length) return { error: null };

    if (OFFLINE_MODE) {

      const { error } =
        await localFetch("/api/table/" + table, {
          method: "POST",
          body: JSON.stringify({ rows })
        });

      return { error };

    }

    const { error } = await sb.from(table).insert(rows);

    return { error };

  },

  async updateRow(table, id, changed) {

    if (OFFLINE_MODE) {

      const { error } =
        await localFetch(
          "/api/table/" + table + "/" + encodeURIComponent(id),
          { method: "PATCH", body: JSON.stringify(changed) }
        );

      return { error };

    }

    const { error } =
      await sb.from(table).update(changed).eq("id", id);

    return { error };

  },

  async deleteRow(table, id) {

    if (OFFLINE_MODE) {

      const { error } =
        await localFetch(
          "/api/table/" + table + "/" + encodeURIComponent(id),
          { method: "DELETE" }
        );

      return { error };

    }

    const { error } = await sb.from(table).delete().eq("id", id);

    return { error };

  },

  /* single admin delete of one attempt record (Results tab) */
  async deleteAttempt(id) {

    if (OFFLINE_MODE) {

      const { data, error } =
        await localFetch(
          "/api/table/attempts/" + encodeURIComponent(id),
          { method: "DELETE" }
        );

      if (error) return { data: null, error };

      return { data, error: null };

    }

    const { data, error } =
      await sb
        .from("attempts")
        .delete()
        .eq("id", id)
        .select("id");

    return { data, error };

  },

  /* fire-and-forget notice sent while the page is being hidden */
  sendLeaveBeacon(attemptID) {

    if (!attemptID) return;

    try {

      if (OFFLINE_MODE) {

        fetch("/api/rpc/leave_attempt", {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ p_attempt_id: attemptID })
        }).catch(() => {});

        return;

      }

      if (!sb) return;

      const headers = {
        "Content-Type": "application/json",
        apikey: CONFIG.SUPABASE_ANON_KEY
      };

      /* legacy anon keys are JWTs and may be sent as the bearer */
      if (CONFIG.SUPABASE_ANON_KEY.startsWith("eyJ")) {

        headers.Authorization =
          "Bearer " + CONFIG.SUPABASE_ANON_KEY;

      }

      fetch(
        CONFIG.SUPABASE_URL + "/rest/v1/rpc/leave_attempt",
        {
          method: "POST",
          keepalive: true,
          headers,
          body: JSON.stringify({ p_attempt_id: attemptID })
        }
      ).catch(() => {});

    } catch (error) {

      /* the normal call below and the server timeout still apply */

    }

  }

};


/* =========================================================
   STATE
   ========================================================= */

/* Teacher's in-memory copy of the shared data.
   (Students never receive this - they only get their own exam.) */
let db = emptyDatabase();

function emptyDatabase() {

  return {
    classes: [],
    questions: [],
    exams: [],
    attempts: [],
    results: []
  };

}

/* What the server last told us, so we only send real changes. */
let snapshot = emptySnapshot();

function emptySnapshot() {

  return {
    classes: new Map(),
    questions: new Map(),
    exams: new Map()
  };

}

let editingQuestionID = null;

/* teacher */
let teacherSignedIn = false;
let teacherPollTimer = null;
let lastFullPull = 0;
let lastSweep = 0;
let pulling = false;
let writeEpoch = 0;
let pendingWrites = 0;
let writeChain = Promise.resolve();
let sigBank = "";
let sigLive = "";

/* student */
let currentExam = null;
let currentAttempt = null;
let studentQuestions = [];
let currentQuestionIndex = 0;
let readyState = null;
let timerInterval = null;
let studentPollTimer = null;
let examEndsAt = 0;
let lastTick = 0;
let pollBusy = false;
let pollFailures = 0;
let startingExam = false;
let submitting = false;
let examEnding = false;
let guardPaused = false;
let pendingLeaveID = null;
let flushPromise = null;
const pendingAnswers = new Set();


function el(id) {

  return document.getElementById(id);

}


function isScreenActive(id) {

  return el(id).classList.contains("active");

}


function setNetworkStatus(state) {

  const pill = el("networkStatus");

  if (!pill) return;

  pill.className =
    "status-pill" +
    (state === "offline"
      ? " offline"
      : state === "off"
        ? " off"
        : "");

  pill.textContent =
    state === "online"
      ? "Online"
      : state === "offline"
        ? "Offline"
        : "Not set up";

}


/* =========================================================
   HELPERS
   ========================================================= */

function generateID(prefix) {

  return (
    prefix +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random()
      .toString(36)
      .substring(2, 7)
  );

}


/* 6 characters, no look-alikes (no 0/O, 1/I/L) */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateExamCode() {

  const bytes = new Uint32Array(6);

  crypto.getRandomValues(bytes);

  return Array.from(
    bytes,
    b => CODE_ALPHABET[b % CODE_ALPHABET.length]
  ).join("");

}


/* =========================================================
   QUESTION TYPES
   ========================================================= */

const QUESTION_TYPES = {
  MULTIPLE_CHOICE: "Multiple Choice",
  TRUE_FALSE: "True or False",
  IDENTIFICATION: "Identification"
};

function questionTypeOf(item) {

  const t = item && (item.type || item.t);

  return QUESTION_TYPES[t] ? t : "MULTIPLE_CHOICE";

}

/* typed answers ignore capital letters and extra spaces
   (the server uses the same rule) */
function normalizeText(value) {

  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

}

/* keyEntry is { c: correct, p: points, t: type } */
function answerMatches(studentAns, keyEntry) {

  if (
    studentAns === null ||
    studentAns === undefined ||
    !keyEntry
  ) {

    return false;

  }

  if (keyEntry.t === "IDENTIFICATION") {

    const given = normalizeText(studentAns);

    return given !== "" &&
      String(keyEntry.c ?? "")
        .split(";")
        .some(alt => normalizeText(alt) === given);

  }

  return studentAns === keyEntry.c;

}

/* what to show in reports: True/False words for T-F items */
function displayAnswer(answer, type) {

  if (type === "TRUE_FALSE") {

    return answer === "A" ? "True" : answer === "B" ? "False" : answer;

  }

  return answer;

}


function escapeHTML(value) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

}


/* =========================================================
   DATABASE (TEACHER SIDE)
   ---------------------------------------------------------
   The teacher screens keep working on the in-memory "db".
   saveDatabase() sends only what changed to Supabase, and a
   background poll pulls in what students / other tabs did.
   ========================================================= */

const TABLE_MAP = {

  classes: {

    table: "classes",

    toRow: c => ({
      id: c.id,
      name: c.name,
      created_at: c.createdAt || new Date().toISOString()
    }),

    fromRow: r => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at
    })

  },

  questions: {

    table: "questions",

    toRow: q => ({
      id: q.id,
      class_id: q.classID,
      text: q.text,
      choices: q.choices,
      correct: q.correct,
      qtype: q.type || "MULTIPLE_CHOICE",
      points: q.points,
      created_at: q.createdAt || new Date().toISOString()
    }),

    fromRow: r => ({
      id: r.id,
      classID: r.class_id,
      text: r.text,
      choices: r.choices,
      correct: r.correct,
      type: r.qtype || "MULTIPLE_CHOICE",
      points: r.points,
      createdAt: r.created_at
    })

  },

  exams: {

    table: "exams",

    toRow: e => ({
      id: e.id,
      title: e.title,
      class_id: e.classID,
      duration: e.duration,
      randomize: e.randomize,
      status: e.status,
      started_at: e.startedAt || null,
      code: e.code,
      created_at: e.createdAt || new Date().toISOString()
    }),

    fromRow: r => ({
      id: r.id,
      title: r.title,
      classID: r.class_id,
      duration: r.duration,
      randomize: r.randomize,
      status: r.status,
      startedAt: r.started_at,
      code: r.code,
      createdAt: r.created_at
    })

  }

};


/* attempts are read-only for the teacher screens; changes go
   through the teacher_end_attempt function instead */
const ATTEMPT_COLUMNS =
  "id,exam_id,student_name,student_sex,student_surname,student_given_name," +
  "student_middle_initial,student_suffix,status,reason,question_ids," +
  "answers,paper,key,score,total,joined_at,started_at,submitted_at," +
  "exited_at,last_seen";


function attemptFromRow(r) {

  return {
    id: r.id,
    examID: r.exam_id,
    studentName: r.student_name,
    sex: r.student_sex || "",
    surname: r.student_surname || "",
    givenName: r.student_given_name || "",
    middleInitial: r.student_middle_initial || "",
    suffix: r.student_suffix || "",
    status: r.status,
    reason: r.reason,
    questionIDs: r.question_ids || [],
    answers: r.answers || [],
    paper: r.paper || [],
    key: r.key || [],
    score: r.score,
    total: r.total,
    joinedAt: r.joined_at,
    startedAt: r.started_at,
    submittedAt: r.submitted_at,
    exitedAt: r.exited_at,
    lastSeen: r.last_seen
  };

}


async function fetchTable(name) {

  const spec = TABLE_MAP[name];

  const { data, error } = await api.selectAll(spec.table);

  if (error) throw error;

  return data.map(spec.fromRow);

}


async function fetchAttempts() {

  /* newest 1000 attempts (the server returns at most 1000 rows) */
  const { data, error } = await api.selectAttempts();

  if (error) throw error;

  return data.map(attemptFromRow);

}


function applyTable(name, rows) {

  db[name] = rows;

  snapshot[name] =
    new Map(
      rows.map(
        o => [o.id, TABLE_MAP[name].toRow(o)]
      )
    );

}


/* Called by every teacher action after it changes "db". */
function saveDatabase() {

  if (!api.ready) return Promise.resolve();

  writeEpoch++;

  pendingWrites++;

  writeChain =
    writeChain
      .then(pushChanges)
      .catch(error => {

        console.error("EXAMGUARD save failed:", error);

        setNetworkStatus("offline");

        showToast(
          "Could not save to the server. " +
          "Check your connection."
        );

      })
      .finally(() => {

        pendingWrites--;

      });

  return writeChain;

}


async function pushChanges() {

  for (const name of ["classes", "questions", "exams"]) {

    const spec = TABLE_MAP[name];

    const snap = snapshot[name];

    const current =
      new Map(
        db[name].map(
          o => [o.id, spec.toRow(o)]
        )
      );

    const inserts = [];
    const updates = [];
    const deletes = [];

    current.forEach((row, id) => {

      const old = snap.get(id);

      if (!old) {

        inserts.push(row);

        return;

      }

      const changed = {};

      Object.keys(row).forEach(key => {

        if (
          JSON.stringify(row[key]) !==
          JSON.stringify(old[key])
        ) {

          changed[key] = row[key];

        }

      });

      if (Object.keys(changed).length) {

        updates.push([id, changed]);

      }

    });

    snap.forEach((row, id) => {

      if (!current.has(id)) deletes.push(id);

    });


    if (inserts.length) {

      const { error } =
        await api.insertRows(spec.table, inserts);

      if (error) throw error;

      inserts.forEach(row => snap.set(row.id, row));

    }

    for (const [id, changed] of updates) {

      const { error } =
        await api.updateRow(spec.table, id, changed);

      if (error) throw error;

      snap.set(id, current.get(id));

    }

    for (const id of deletes) {

      const { error } =
        await api.deleteRow(spec.table, id);

      if (error) throw error;

      snap.delete(id);

    }

  }

  setNetworkStatus("online");

}


/* Turns the attempts into the rows shown on the Results tab. */
function rebuildResults() {

  db.results =
    db.attempts
      .filter(
        a =>
          a.startedAt &&
          (a.status === "SUBMITTED" || a.status === "EXITED")
      )
      .map(a => {

        const exam =
          db.exams.find(e => e.id === a.examID);

        const total = a.total || 0;

        return {

          id: a.id,

          examID: a.examID,

          examTitle:
            exam ? exam.title : "(deleted exam)",

          studentName: a.studentName,

          sex: a.sex || "",

          surname: a.surname || "",

          givenName: a.givenName || "",

          middleInitial: a.middleInitial || "",

          suffix: a.suffix || "",

          score: a.score,

          total,

          questionIDs: a.questionIDs || [],

          paper: a.paper || [],

          key: a.key || [],

          answers: a.answers || [],

          percentage:
            total > 0
              ? Math.round(a.score / total * 100)
              : 0,

          status: a.status,

          reason: a.reason,

          submittedAt:
            a.submittedAt || a.exitedAt || a.joinedAt

        };

      })
      .sort(
        (x, y) =>
          new Date(x.submittedAt) - new Date(y.submittedAt)
      );

}


function resultStatus(result) {

  if (result.status === "SUBMITTED") {

    return { cls: "SUBMITTED", label: "SUBMITTED" };

  }

  if (result.reason === "LEFT_SCREEN") {

    return { cls: "INTERRUPTED", label: "LEFT SCREEN" };

  }

  if (result.reason === "SIGNAL_LOST") {

    return { cls: "INTERRUPTED", label: "SIGNAL LOST" };

  }

  return { cls: "EXITED", label: "TERMINATED" };

}


function monitorStatus(attempt) {

  if (attempt.status === "EXITED") {

    if (attempt.reason === "LEFT_SCREEN") {

      return {
        cls: "INTERRUPTED",
        label: "INTERRUPTED",
        note: "Left the exam screen"
      };

    }

    if (attempt.reason === "SIGNAL_LOST") {

      return {
        cls: "INTERRUPTED",
        label: "INTERRUPTED",
        note: "Signal lost"
      };

    }

    return {
      cls: "EXITED",
      label: "EXITED",
      note: "Ended by teacher"
    };

  }

  if (
    attempt.status === "ANSWERING" &&
    attempt.lastSeen
  ) {

    const silent =
      Math.round(
        (Date.now() - new Date(attempt.lastSeen)) / 1000
      );

    if (silent > 15) {

      return {
        cls: "ANSWERING",
        label: "ANSWERING",
        note: `⚠ no signal for ${silent}s`,
        warn: true
      };

    }

  }

  if (
    attempt.status === "SUBMITTED" &&
    attempt.reason === "TIME_UP"
  ) {

    return {
      cls: "SUBMITTED",
      label: "SUBMITTED",
      note: "Time was up"
    };

  }

  return {
    cls: attempt.status,
    label: attempt.status,
    note: ""
  };

}


/* ---------- teacher: pull the latest data ---------- */

function renderAfterPull() {

  const bank =
    JSON.stringify([db.classes, db.questions]);

  const live =
    JSON.stringify([db.exams, db.attempts]);

  const bankChanged = bank !== sigBank;

  const liveChanged = live !== sigLive;

  sigBank = bank;

  sigLive = live;

  if (bankChanged) {

    renderTeacherDashboard();

  } else if (liveChanged) {

    renderTeacherLive();

  }

}


async function refreshTeacher(full = false) {

  if (!api.ready || !teacherSignedIn || pulling) return;

  pulling = true;

  const epoch = writeEpoch;

  try {

    const jobs = [fetchTable("exams"), fetchAttempts()];

    if (full) {

      jobs.push(
        fetchTable("classes"),
        fetchTable("questions")
      );

    }

    const [exams, attempts, classes, questions] =
      await Promise.all(jobs);

    setNetworkStatus("online");

    /* the teacher changed something while we were fetching:
       drop this copy, the next poll will be up to date */
    if (epoch !== writeEpoch || pendingWrites > 0) return;

    applyTable("exams", exams);

    db.attempts = attempts;

    if (full) {

      applyTable("classes", classes);

      applyTable("questions", questions);

      lastFullPull = Date.now();

    }

    rebuildResults();

    renderAfterPull();

  } catch (error) {

    console.error("EXAMGUARD refresh failed:", error);

    setNetworkStatus("offline");

  } finally {

    pulling = false;

  }

}


function startTeacherPolling() {

  stopTeacherPolling();

  teacherPollTimer =
    setInterval(() => {

      if (
        !teacherSignedIn ||
        document.hidden ||
        !isScreenActive("teacherDashboard")
      ) {

        return;

      }

      refreshTeacher(
        Date.now() - lastFullPull > 20000
      );

      if (Date.now() - lastSweep > 10000) {

        lastSweep = Date.now();

        /* finishes students who went silent (phone frozen) */
        api.rpc("teacher_sweep").then(
          () => {},
          () => {}
        );

      }

    }, CONFIG.TEACHER_POLL_MS);

}


function stopTeacherPolling() {

  clearInterval(teacherPollTimer);

  teacherPollTimer = null;

}


/* =========================================================
   BASIC UI
   ========================================================= */

function showScreen(id) {

  document
    .querySelectorAll(".screen")
    .forEach(screen =>
      screen.classList.remove("active")
    );

  document
    .getElementById(id)
    .classList.add("active");

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });

}


function showHome() {

  /* leaving in the middle of an exam ends it */
  if (examIsRunning()) {

    guardPaused = true;

    const leave =
      confirm(
        "Leaving now will END your examination.\n\n" +
        "Only the answers you already gave will be recorded."
      );

    guardPaused = false;

    lastTick = Date.now();

    if (leave) endExamForLeaving();

    return;

  }

  clearInterval(timerInterval);

  leaveLobby();

  showScreen("homeScreen");

}


async function showTeacherLogin() {

  showScreen("teacherLoginScreen");

  const message = el("loginMessage");

  message.textContent = "";

  const emailField = el("teacherEmailField");

  if (emailField) {

    emailField.classList.toggle("hidden", OFFLINE_MODE);

  }

  const note = el("loginModeNote");

  if (note) {

    note.textContent =
      OFFLINE_MODE
        ? "Offline mode (local network). Enter the classroom password."
        : "Sign in with your teacher account to manage examinations.";

  }

  if (!api.ready) {

    message.textContent = SERVER_UNAVAILABLE;

    return;

  }

  /* already signed in on this device? go straight in */
  try {

    const { data } = await api.auth.getSession();

    if (data.session && await checkIsTeacher()) {

      await enterTeacherDashboard();

    }

  } catch (error) {

    /* no connection: the sign-in form stays visible */

  }

}


function showStudentJoin() {

  showScreen("studentJoinScreen");

  el("joinMessage").textContent =
    api.ready ? "" : SERVER_UNAVAILABLE;

}


function showToast(message) {

  const toast =
    document.getElementById("toast");

  toast.textContent = message;

  toast.classList.add("show");

  setTimeout(() => {

    toast.classList.remove("show");

  }, 2500);

}



/* =========================================================
   TEACHER LOGIN
   ========================================================= */

async function checkIsTeacher() {

  const { data, error } = await api.rpc("is_teacher");

  return !error && data === true;

}


async function enterTeacherDashboard() {

  teacherSignedIn = true;

  sigBank = "";

  sigLive = "";

  lastFullPull = 0;

  showScreen("teacherDashboard");

  await refreshTeacher(true);

  startTeacherPolling();

}


async function teacherLogin() {

  const message = el("loginMessage");

  if (!api.ready) {

    message.textContent = SERVER_UNAVAILABLE;

    return;

  }

  const email =
    OFFLINE_MODE ? "" : el("teacherEmail").value.trim();

  const password =
    el("teacherPassword").value;

  if ((!OFFLINE_MODE && !email) || !password) {

    message.textContent =
      OFFLINE_MODE
        ? "Enter the classroom password."
        : "Enter your email and password.";

    return;

  }

  const button =
    document.querySelector(
      "#teacherLoginScreen .primary-btn"
    );

  button.disabled = true;

  message.textContent = "";

  try {

    const { error } =
      await api.auth.signInWithPassword({ email, password });

    if (error) {

      message.textContent =
        OFFLINE_MODE
          ? "Incorrect password."
          : "Incorrect email or password.";

      return;

    }

    if (!(await checkIsTeacher())) {

      await api.auth.signOut();

      message.textContent =
        "This account is not a teacher account.";

      return;

    }

    el("teacherPassword").value = "";

    await enterTeacherDashboard();

    showToast("Teacher login successful.");

  } catch (error) {

    message.textContent =
      "Could not reach the server. " +
      "Check your internet connection.";

  } finally {

    button.disabled = false;

  }

}


async function teacherLogout() {

  teacherSignedIn = false;

  stopTeacherPolling();

  if (api.ready) {

    try {

      await api.auth.signOut();

    } catch (error) {

      /* signing out locally is enough */

    }

  }

  /* do not leave the teacher's data in memory */
  db = emptyDatabase();

  snapshot = emptySnapshot();

  sigBank = "";

  sigLive = "";

  renderTeacherDashboard();

  showHome();

  showToast("Teacher session ended.");

}


/* ---------- small helpers for the teacher screens ---------- */

function countInterrupted(attempts) {

  return attempts.filter(
    a =>
      a.status === "EXITED" &&
      (a.reason === "LEFT_SCREEN" || a.reason === "SIGNAL_LOST")
  ).length;

}


function countTeacherExited(attempts) {

  return (
    attempts.filter(a => a.status === "EXITED").length -
    countInterrupted(attempts)
  );

}


function statusCellHTML(attempt) {

  const info = monitorStatus(attempt);

  return `
    <span class="status ${info.cls}">
      ${info.label}
    </span>
    ${info.note
      ? `<div class="status-note ${info.warn ? "warn" : ""}">
          ${escapeHTML(info.note)}
        </div>`
      : ""}
  `;

}


/* keeps the teacher's chosen class when the lists refresh */
function setClassOptions(id, options) {

  const select = el(id);

  const previous = select.value;

  select.innerHTML = options;

  if (
    previous &&
    Array.from(select.options).some(o => o.value === previous)
  ) {

    select.value = previous;

  }

}


/* =========================================================
   TEACHER TABS
   ========================================================= */

function openTeacherTab(
  tabID,
  button
) {

  document
    .querySelectorAll(".teacher-tab")
    .forEach(tab =>
      tab.classList.remove("active")
    );


  document
    .querySelectorAll(".dash-tab")
    .forEach(tab =>
      tab.classList.remove("active")
    );


  document
    .getElementById(tabID)
    .classList.add("active");


  if (button) {

    button.classList.add("active");

  }


  if (tabID === "monitorTab") {

    populateMonitorExamList();

    renderMonitor();

  }


  if (tabID === "resultsTab") {

    renderResults();

  }

}


/* =========================================================
   DASHBOARD
   ========================================================= */

function renderTeacherDashboard() {

  document.getElementById(
    "classCount"
  ).textContent =
    db.classes.length;


  document.getElementById(
    "questionCount"
  ).textContent =
    db.questions.length;


  document.getElementById(
    "examCount"
  ).textContent =
    db.exams.length;


  document.getElementById(
    "submissionCount"
  ).textContent =
    db.results.length;


  populateClassSelects();

  renderClasses();

  renderQuestions();

  renderExams();

  populateMonitorExamList();

  renderMonitor();

  renderResults();

  renderActiveExam();

}


/* =========================================================
   CLASS MANAGEMENT
   ========================================================= */

function createClass() {

  const input =
    document.getElementById(
      "newClassName"
    );

  const name =
    input.value.trim();


  if (!name) {

    showToast(
      "Please enter a class name."
    );

    return;

  }


  db.classes.push({

    id:
      generateID("CLASS"),

    name,

    createdAt:
      new Date().toISOString()

  });


  saveDatabase();

  input.value = "";

  renderTeacherDashboard();

  showToast(
    "Class created successfully."
  );

}


function renderClasses() {

  const container =
    document.getElementById(
      "classList"
    );


  if (!db.classes.length) {

    container.innerHTML =
      `<div class="empty-state">
        No classes created yet.
      </div>`;

    return;

  }


  container.innerHTML =
    db.classes.map(cls => {

      const questionCount =
        db.questions.filter(
          q =>
            q.classID === cls.id
        ).length;


      const examCount =
        db.exams.filter(
          exam =>
            exam.classID === cls.id
        ).length;


      return `

        <div class="item-card">

          <h4>
            ${escapeHTML(cls.name)}
          </h4>

          <p>
            ${questionCount} questions
            •
            ${examCount} exams
          </p>

          <div class="item-actions">

            <button
              class="mini-btn red"
              onclick="deleteClass('${cls.id}')"
            >
              🗑️ Delete
            </button>

          </div>

        </div>

      `;

    }).join("");

}


/* =========================================================
   SELECT OPTIONS
   ========================================================= */

function populateClassSelects() {

  const options =
    db.classes.length

      ? db.classes.map(cls =>

          `<option value="${cls.id}">
            ${escapeHTML(cls.name)}
          </option>`

        ).join("")

      : `<option value="">
          No classes available
        </option>`;


  setClassOptions("questionClass", options);

  setClassOptions("examClass", options);

  /* question bank filter: every class with its question count */
  const filterOptions =
    `<option value="ALL">All classes (${db.questions.length})</option>` +
    db.classes.map(cls => {

      const count =
        db.questions.filter(q => q.classID === cls.id).length;

      return `<option value="${cls.id}">${
        escapeHTML(cls.name)
      } (${count})</option>`;

    }).join("");

  setClassOptions("questionFilter", filterOptions);

}


/* =========================================================
   QUESTION BANK
   ========================================================= */

/* shows only the fields that belong to the chosen question type */
function updateQuestionTypeFields() {

  const type =
    document.getElementById("questionType").value;

  document.getElementById("mcFields")
    .classList.toggle("hidden", type !== "MULTIPLE_CHOICE");

  document.getElementById("tfFields")
    .classList.toggle("hidden", type !== "TRUE_FALSE");

  document.getElementById("identFields")
    .classList.toggle("hidden", type !== "IDENTIFICATION");

}


function saveQuestion() {

  const classID =
    document.getElementById("questionClass").value;

  const questionText =
    document.getElementById("questionText").value.trim();

  const type =
    document.getElementById("questionType").value;

  const points =
    Math.max(
      1,
      Number(
        document.getElementById("questionPoints").value
      ) || 1
    );

  let choices;
  let correct;

  if (type === "IDENTIFICATION") {

    choices = {};

    correct =
      document.getElementById("identAnswer").value.trim();

    if (
      !correct.split(";").some(part => part.trim() !== "")
    ) {

      showToast("Please enter the correct answer.");

      return;

    }

  } else if (type === "TRUE_FALSE") {

    choices = { A: "True", B: "False" };

    correct =
      document.getElementById("tfAnswer").value;

  } else {

    const A = document.getElementById("choiceA").value.trim();
    const B = document.getElementById("choiceB").value.trim();
    const C = document.getElementById("choiceC").value.trim();
    const D = document.getElementById("choiceD").value.trim();

    if (!A || !B || !C || !D) {

      showToast("Please complete all four choices.");

      return;

    }

    choices = { A, B, C, D };

    correct =
      document.getElementById("correctAnswer").value;

  }

  if (!classID || !questionText) {

    showToast("Please select a class and enter the question.");

    return;

  }


  /* ---------- EDIT EXISTING ---------- */

  if (editingQuestionID) {

    const question =
      db.questions.find(q => q.id === editingQuestionID);

    if (!question) {

      resetQuestionForm();

      showToast("That question no longer exists.");

      return;

    }

    question.classID = classID;
    question.text = questionText;
    question.type = type;
    question.choices = choices;
    question.correct = correct;
    question.points = points;

    saveDatabase();

    resetQuestionForm();

    showClassInBank(classID);

    renderTeacherDashboard();

    showToast("Question updated.");

    return;

  }


  /* ---------- ADD NEW ---------- */

  db.questions.push({

    id: generateID("Q"),

    classID,

    text: questionText,

    type,

    choices,

    correct,

    points,

    createdAt: new Date().toISOString()

  });

  saveDatabase();

  document.getElementById("questionText").value = "";
  document.getElementById("choiceA").value = "";
  document.getElementById("choiceB").value = "";
  document.getElementById("choiceC").value = "";
  document.getElementById("choiceD").value = "";
  document.getElementById("identAnswer").value = "";

  showClassInBank(classID);

  renderTeacherDashboard();

  showToast("Question added to the question bank.");

}


function editQuestion(questionID) {

  const question =
    db.questions.find(q => q.id === questionID);

  if (!question) return;

  editingQuestionID = questionID;

  document.getElementById("questionClass").value = question.classID;
  document.getElementById("questionText").value = question.text;
  const type = questionTypeOf(question);

  document.getElementById("questionType").value = type;

  document.getElementById("choiceA").value =
    type === "MULTIPLE_CHOICE" ? question.choices.A : "";
  document.getElementById("choiceB").value =
    type === "MULTIPLE_CHOICE" ? question.choices.B : "";
  document.getElementById("choiceC").value =
    type === "MULTIPLE_CHOICE" ? question.choices.C : "";
  document.getElementById("choiceD").value =
    type === "MULTIPLE_CHOICE" ? question.choices.D : "";

  document.getElementById("correctAnswer").value =
    type === "MULTIPLE_CHOICE" ? question.correct : "A";
  document.getElementById("tfAnswer").value =
    type === "TRUE_FALSE" ? question.correct : "A";
  document.getElementById("identAnswer").value =
    type === "IDENTIFICATION" ? question.correct : "";

  document.getElementById("questionPoints").value = question.points;

  updateQuestionTypeFields();

  document.getElementById("questionFormLabel").textContent =
    "EDITING QUESTION";

  document.getElementById("questionFormTitle").textContent =
    "Edit Question";

  document.getElementById("questionSubmitBtn").textContent =
    "SAVE CHANGES";

  document.getElementById("questionCancelBtn")
    .classList.remove("hidden");

  renderQuestions();

  document.getElementById("questionFormPanel")
    .scrollIntoView({ behavior: "smooth", block: "start" });

  document.getElementById("questionText").focus({ preventScroll: true });

}


function cancelQuestionEdit() {

  resetQuestionForm();

  renderQuestions();

}


function resetQuestionForm() {

  editingQuestionID = null;

  document.getElementById("questionText").value = "";
  document.getElementById("choiceA").value = "";
  document.getElementById("choiceB").value = "";
  document.getElementById("choiceC").value = "";
  document.getElementById("choiceD").value = "";
  document.getElementById("correctAnswer").value = "A";
  document.getElementById("tfAnswer").value = "A";
  document.getElementById("identAnswer").value = "";
  document.getElementById("questionPoints").value = 1;

  updateQuestionTypeFields();

  document.getElementById("questionFormLabel").textContent =
    "QUESTION BANK";

  document.getElementById("questionFormTitle").textContent =
    "Add Question";

  document.getElementById("questionSubmitBtn").textContent =
    "ADD QUESTION";

  document.getElementById("questionCancelBtn")
    .classList.add("hidden");

}


function deleteQuestion(questionID) {

  const question =
    db.questions.find(q => q.id === questionID);

  if (!question) return;

  const activeStudents =
    db.attempts.filter(
      a =>
        a.status === "ANSWERING" &&
        a.questionIDs.includes(questionID)
    ).length;

  let message =
    `Delete this question?\n\n"${question.text}"`;

  if (activeStudents > 0) {

    message +=
      `\n\nWarning: ${activeStudents} student(s) are currently ` +
      `answering an exam that includes this question.`;

  }

  message +=
    "\n\nSubmitted results are not affected. This cannot be undone.";

  if (!confirm(message)) return;

  db.questions =
    db.questions.filter(q => q.id !== questionID);

  if (editingQuestionID === questionID) {

    resetQuestionForm();

  }

  saveDatabase();

  renderTeacherDashboard();

  showToast("Question deleted.");

}


/* choose which class's questions are listed; the form follows it */
function onQuestionFilterChange() {

  const filterClass = el("questionFilter").value;

  if (!editingQuestionID && filterClass !== "ALL") {

    el("questionClass").value = filterClass;

  }

  renderQuestions();

}


/* keeps the list on the class a question was just saved to */
function showClassInBank(classID) {

  const filter = el("questionFilter");

  if (
    filter.value !== "ALL" &&
    filter.value !== classID
  ) {

    filter.value = classID;

  }

}


/* the "Add Question" button above the list */
function startNewQuestion() {

  if (!db.classes.length) {

    showToast("Create a class first, then add its questions.");

    return;

  }

  if (editingQuestionID) {

    resetQuestionForm();

  }

  const filterClass = el("questionFilter").value;

  if (filterClass && filterClass !== "ALL") {

    el("questionClass").value = filterClass;

  }

  renderQuestions();

  el("questionFormPanel")
    .scrollIntoView({ behavior: "smooth", block: "start" });

  el("questionText").focus({ preventScroll: true });

}


function renderQuestions() {

  const container =
    document.getElementById("questionList");

  const filterClass =
    el("questionFilter").value || "ALL";

  const visible =
    filterClass === "ALL"
      ? db.questions
      : db.questions.filter(q => q.classID === filterClass);


  if (!visible.length) {

    const cls =
      db.classes.find(c => c.id === filterClass);

    container.innerHTML =
      `<div class="empty-state">
        ${cls
          ? `No questions for <strong>${escapeHTML(cls.name)}</strong> yet.`
          : "No questions added yet."}
        <div class="bank-empty-add">
          <button
            class="primary-btn"
            onclick="startNewQuestion()"
          >
            ➕ ADD QUESTION
          </button>
        </div>
      </div>`;

    return;

  }


  container.innerHTML =
    visible.map(
      (q, index) => {

        const cls =
          db.classes.find(c => c.id === q.classID);

        const isEditing =
          q.id === editingQuestionID;

        return `

          <div class="item-card${isEditing ? " editing" : ""}">

            <h4>
              ${index + 1}.
              ${escapeHTML(q.text)}
              ${isEditing
                ? '<span class="editing-tag">EDITING</span>'
                : ""}
            </h4>

            <p>
              <span class="status SUBMITTED">${
                QUESTION_TYPES[questionTypeOf(q)]
              }</span>
            </p>

            ${questionTypeOf(q) === "IDENTIFICATION"
              ? ""
              : Object.entries(q.choices).map(
                  ([letter, text]) =>
                    `<p>${letter}. ${escapeHTML(text)}</p>`
                ).join("")}

            <p>
              <strong>Correct: ${
                questionTypeOf(q) === "TRUE_FALSE"
                  ? displayAnswer(q.correct, "TRUE_FALSE")
                  : escapeHTML(q.correct)
              }</strong>
              •
              ${q.points} point(s)
              •
              ${cls
                ? escapeHTML(cls.name)
                : "Unknown Class"}
            </p>

            <div class="item-actions">

              <button
                class="mini-btn"
                onclick="editQuestion('${q.id}')"
              >
                ✏️ Edit
              </button>

              <button
                class="mini-btn red"
                onclick="deleteQuestion('${q.id}')"
              >
                🗑️ Delete
              </button>

            </div>

          </div>

        `;

      }
    ).join("");

}


/* =========================================================
   EXAM MANAGEMENT
   ========================================================= */

function createExam() {

  const title =
    document.getElementById(
      "examTitle"
    ).value.trim();


  const classID =
    document.getElementById(
      "examClass"
    ).value;


  const duration =
    Number(
      document.getElementById(
        "examDuration"
      ).value
    ) || 30;


  const randomize =
    document.getElementById(
      "randomizeExam"
    ).checked;


  if (!title || !classID) {

    showToast(
      "Enter an exam title and class."
    );

    return;

  }


  const questions =
    db.questions.filter(
      q =>
        q.classID === classID
    );


  if (!questions.length) {

    showToast(
      "Add questions to this class first."
    );

    return;

  }


  let examCode =
    generateExamCode();


  while (
    db.exams.some(
      exam =>
        exam.code === examCode
    )
  ) {

    examCode =
      generateExamCode();

  }


  db.exams.push({

    id:
      generateID("EXAM"),

    title,

    classID,

    duration,

    randomize,

    status:
      "OPEN",

    startedAt:
      null,

    code:
      examCode,

    createdAt:
      new Date().toISOString()

  });


  saveDatabase();


  document.getElementById(
    "examTitle"
  ).value = "";


  renderTeacherDashboard();


  showToast(
    `Exam created. Code: ${examCode}`
  );

}


function examState(exam) {

  if (exam.status !== "OPEN") {

    return { key: "closed", label: "CLOSED" };

  }

  if (!exam.startedAt) {

    return { key: "waiting", label: "WAITING ROOM" };

  }

  return { key: "started", label: "STARTED" };

}


function formatClock(iso) {

  return new Date(iso).toLocaleTimeString(
    [],
    { hour: "2-digit", minute: "2-digit" }
  );

}


function renderExams() {

  const container =
    document.getElementById("examList");


  if (!db.exams.length) {

    container.innerHTML =
      `<div class="empty-state">
        No examinations created.
      </div>`;

    return;

  }


  container.innerHTML =
    db.exams.map(exam => {

      const cls =
        db.classes.find(c => c.id === exam.classID);

      const questionCount =
        db.questions.filter(
          q => q.classID === exam.classID
        ).length;

      const state = examState(exam);

      const waitingCount =
        db.attempts.filter(
          a =>
            a.examID === exam.id &&
            a.status === "WAITING"
        ).length;


      return `

        <div class="item-card">

          <h4>
            ${escapeHTML(exam.title)}
          </h4>

          <p>
            ${cls
              ? escapeHTML(cls.name)
              : "Unknown class"}
          </p>

          <div class="exam-code">
            ${exam.code}
          </div>

          <div class="exam-meta">

            <span class="meta-pill">
              ⏱ ${exam.duration} minutes
            </span>

            <span class="meta-pill">
              📝 ${questionCount} questions
            </span>

            <span class="meta-pill">
              🔀
              ${exam.randomize
                ? "Randomized"
                : "Standard"}
            </span>

            <span class="meta-pill state-${state.key}">
              ${state.label}
            </span>

            ${state.key === "waiting"
              ? `<span class="meta-pill">
                  👥 ${waitingCount} waiting
                </span>`
              : ""}

            ${exam.startedAt
              ? `<span class="meta-pill">
                  Started ${formatClock(exam.startedAt)}
                </span>`
              : ""}

          </div>

          <div class="item-actions">

            ${state.key === "waiting"
              ? `<button
                  class="mini-btn start"
                  onclick="teacherStartExam('${exam.id}')"
                >
                  ▶ Start Exam
                </button>`
              : ""}

            <button
              class="mini-btn green"
              onclick="copyExamCode('${exam.code}')"
            >
              Copy Code
            </button>

            <button
              class="mini-btn"
              onclick="toggleExam('${exam.id}')"
            >
              ${exam.status === "OPEN"
                ? "Close Exam"
                : "Open Exam"}
            </button>

            <button
              class="mini-btn red"
              onclick="deleteExam('${exam.id}')"
            >
              🗑️ Delete
            </button>

          </div>

        </div>

      `;

    }).join("");

}


function teacherStartExam(examID) {

  const exam =
    db.exams.find(e => e.id === examID);

  if (!exam) return;

  if (exam.status !== "OPEN") {

    showToast("Open the exam before starting it.");

    return;

  }

  if (exam.startedAt) return;

  const waiting =
    db.attempts.filter(
      a =>
        a.examID === exam.id &&
        a.status === "WAITING"
    ).length;

  if (
    !confirm(
      `Start "${exam.title}" now?\n\n` +
      `${waiting} student(s) in the waiting room ` +
      `will be able to begin immediately.`
    )
  ) {

    return;

  }

  exam.startedAt = new Date().toISOString();

  saveDatabase();

  renderTeacherLive();

  showToast("Exam started. Students can now begin.");

}


function copyExamCode(code) {

  navigator.clipboard
    .writeText(code)
    .then(() => {

      showToast(
        `Exam code ${code} copied.`
      );

    });

}


function toggleExam(examID) {

  const exam =
    db.exams.find(
      e =>
        e.id === examID
    );


  if (!exam) return;


  exam.status =
    exam.status === "OPEN"
      ? "CLOSED"
      : "OPEN";


  saveDatabase();

  renderTeacherDashboard();

  showToast(
    `Exam ${exam.status.toLowerCase()}.`
  );

}


/* =========================================================
   ACTIVE EXAM
   ========================================================= */

function renderActiveExam() {

  const container =
    document.getElementById("activeExamCard");


  const activeExam =
    db.exams.find(exam => exam.status === "OPEN");


  if (!activeExam) {

    container.innerHTML =
      `<div class="empty-state">
        No active examination.
      </div>`;

    return;

  }


  const cls =
    db.classes.find(c => c.id === activeExam.classID);

  const attempts =
    db.attempts.filter(
      attempt => attempt.examID === activeExam.id
    );

  const waitingList =
    attempts.filter(a => a.status === "WAITING");

  const answering =
    attempts.filter(a => a.status === "ANSWERING").length;

  const submitted =
    attempts.filter(a => a.status === "SUBMITTED").length;


  const roomHTML =
    !activeExam.startedAt

      ? `
        <div class="room-box">

          <div class="room-head">
            <strong>👥 Waiting room</strong>
            <span>${waitingList.length} waiting</span>
          </div>

          <div class="room-list">
            ${waitingList.length
              ? waitingList.map(a =>
                  `<span class="room-chip">
                    ${escapeHTML(a.studentName)}
                  </span>`
                ).join("")
              : `<em>No students yet. Share the exam code above.</em>`}
          </div>

          <button
            class="primary-btn full"
            onclick="teacherStartExam('${activeExam.id}')"
          >
            ▶ START EXAM
          </button>

          <small>
            Students can enter the waiting room now, but
            cannot begin until you press Start.
          </small>

        </div>`

      : `
        <div class="room-box started">
          ✅ Started at ${formatClock(activeExam.startedAt)}
          • ${answering} answering
          • ${submitted} submitted
        </div>`;


  container.innerHTML = `

    <div>

      <p>
        ${escapeHTML(activeExam.title)}
      </p>

      <div class="exam-code">
        ${activeExam.code}
      </div>

      <div class="exam-meta">

        <span class="meta-pill">
          Class:
          ${cls
            ? escapeHTML(cls.name)
            : "Unknown"}
        </span>

        <span class="meta-pill">
          Duration:
          ${activeExam.duration} min
        </span>

        <span class="meta-pill">
          Students:
          ${attempts.length}
        </span>

      </div>

      ${roomHTML}

    </div>

  `;

}


/* ---------- light refresh used by live sync ---------- */

function renderTeacherLive() {

  document.getElementById("classCount").textContent =
    db.classes.length;

  document.getElementById("questionCount").textContent =
    db.questions.length;

  document.getElementById("examCount").textContent =
    db.exams.length;

  document.getElementById("submissionCount").textContent =
    db.results.length;

  renderActiveExam();

  renderExams();

  populateMonitorExamList();

  renderMonitor();

  renderResults();

}


/* =========================================================
   MONITORING
   ========================================================= */

function populateMonitorExamList() {

  const select =
    document.getElementById("monitorExam");

  const previous = select.value;


  if (!db.exams.length) {

    select.innerHTML =
      `<option value="">
        No exams
      </option>`;

    return;

  }


  select.innerHTML =
    db.exams.map(
      exam =>

        `<option value="${exam.id}">
          ${escapeHTML(exam.title)}
          (${exam.code})
        </option>`

    ).join("");


  if (
    previous &&
    db.exams.some(e => e.id === previous)
  ) {

    select.value = previous;

  }

}


function renderMonitorStartBar(exam) {

  const bar =
    document.getElementById("monitorStartBar");

  if (!exam) {

    bar.className = "start-bar hidden";

    bar.innerHTML = "";

    return;

  }

  const state = examState(exam);

  if (state.key === "waiting") {

    bar.className = "start-bar waiting";

    bar.innerHTML = `
      <div>
        <strong>Waiting room is open</strong>
        <span>
          Students can join, but cannot begin until
          you start the exam.
        </span>
      </div>

      <button
        class="primary-btn"
        onclick="teacherStartExam('${exam.id}')"
      >
        ▶ START EXAM
      </button>
    `;

  } else if (state.key === "started") {

    bar.className = "start-bar started";

    bar.innerHTML = `
      <div>
        <strong>Exam started</strong>
        <span>Started at ${formatClock(exam.startedAt)}</span>
      </div>
    `;

  } else {

    bar.className = "start-bar closed";

    bar.innerHTML = `
      <div>
        <strong>Exam closed</strong>
        <span>
          Open it again from Exams &amp; Quizzes to
          let students in.
        </span>
      </div>
    `;

  }

}


function renderMonitor() {

  const select =
    document.getElementById("monitorExam");

  const examID =
    select.value || db.exams[0]?.id;

  if (!examID) {

    renderMonitorStartBar(null);

    return;

  }

  select.value = examID;

  renderMonitorStartBar(
    db.exams.find(e => e.id === examID)
  );


  const attempts =
    db.attempts.filter(
      attempt => attempt.examID === examID
    );

  const count =
    status =>
      attempts.filter(a => a.status === status).length;


  document.getElementById("waitingCount").textContent =
    count("WAITING");

  document.getElementById("answeringCount").textContent =
    count("ANSWERING");

  document.getElementById("interruptedCount").textContent =
    countInterrupted(attempts);

  document.getElementById("submittedCount").textContent =
    count("SUBMITTED");

  document.getElementById("exitedCount").textContent =
    countTeacherExited(attempts);


  const body =
    document.getElementById("monitorBody");


  if (!attempts.length) {

    body.innerHTML = `

      <tr>

        <td
          colspan="5"
          style="text-align:center;color:#667085"
        >
          No students have joined this examination.
        </td>

      </tr>

    `;

    return;

  }


  body.innerHTML =
    attempts.map(
      attempt => {

        const total = attempt.questionIDs.length;

        const answered =
          attempt.answers.filter(
            answer => answer !== null
          ).length;

        const progress =
          total
            ? Math.round(answered / total * 100)
            : 0;

        const notStarted =
          attempt.status === "WAITING" && !total;

        let action = "—";

        if (attempt.status === "ANSWERING") {

          action = `<button
            class="mini-btn red"
            onclick="terminateAttempt('${attempt.id}')"
          >
            Terminate
          </button>`;

        } else if (attempt.status === "WAITING") {

          action = `<button
            class="mini-btn red"
            onclick="terminateAttempt('${attempt.id}')"
          >
            Remove
          </button>`;

        }

        /* a student who is still answering must be terminated
           first; every other record can be deleted */
        if (attempt.status !== "ANSWERING") {

          action += ` <button
            class="mini-btn red"
            onclick="deleteAttempt('${attempt.id}')"
          >
            🗑️ Delete
          </button>`;

        }

        if (action.startsWith("— ")) action = action.slice(2);

        return `

          <tr>

            <td>
              <strong>
                ${escapeHTML(attempt.studentName)}
              </strong>
            </td>

            <td>
              ${statusCellHTML(attempt)}
            </td>

            <td>
              ${notStarted
                ? "—"
                : `${answered}/${total} (${progress}%)`}
            </td>

            <td>
              ${attempt.startedAt &&
                (attempt.status === "SUBMITTED" ||
                 attempt.status === "EXITED")
                ? attempt.score
                : "—"}
            </td>

            <td>
              ${action}
            </td>

          </tr>

        `;

      }
    ).join("");

}

/* =========================================================
   DELETE (class / exam / student record)
   ========================================================= */

function deleteClass(classID) {

  const cls = db.classes.find(c => c.id === classID);

  if (!cls) return;

  const questions =
    db.questions.filter(q => q.classID === classID);

  const exams =
    db.exams.filter(e => e.classID === classID);

  const examIDs = new Set(exams.map(e => e.id));

  const attempts =
    db.attempts.filter(a => examIDs.has(a.examID));

  const running =
    exams.some(e => e.status === "OPEN" && e.startedAt);

  let message =
    `Delete the class "${cls.name}"?\n\n` +
    "This will also permanently delete:\n" +
    `• ${questions.length} question(s)\n` +
    `• ${exams.length} exam(s)\n` +
    `• ${attempts.length} student record(s) and results`;

  if (running) {

    message +=
      "\n\nWarning: an exam of this class is currently running.";

  }

  message += "\n\nThis cannot be undone.";

  if (!confirm(message)) return;

  db.classes = db.classes.filter(c => c.id !== classID);

  db.questions =
    db.questions.filter(q => q.classID !== classID);

  db.exams =
    db.exams.filter(e => e.classID !== classID);

  db.attempts =
    db.attempts.filter(a => !examIDs.has(a.examID));

  if (
    editingQuestionID &&
    !db.questions.some(q => q.id === editingQuestionID)
  ) {

    resetQuestionForm();

  }

  rebuildResults();

  /* the server removes the class's questions, exams and
     student records automatically (on delete cascade) */
  saveDatabase();

  renderTeacherDashboard();

  showToast("Class deleted.");

}


function deleteExam(examID) {

  const exam = db.exams.find(e => e.id === examID);

  if (!exam) return;

  const attempts =
    db.attempts.filter(a => a.examID === examID);

  const answering =
    attempts.filter(a => a.status === "ANSWERING").length;

  let message =
    `Delete the exam "${exam.title}" (${exam.code})?\n\n` +
    `This will also permanently delete ${attempts.length} ` +
    "student record(s) and results of this exam.";

  if (answering > 0) {

    message +=
      `\n\nWarning: ${answering} student(s) are answering it right now.`;

  }

  message += "\n\nThis cannot be undone.";

  if (!confirm(message)) return;

  db.exams = db.exams.filter(e => e.id !== examID);

  db.attempts =
    db.attempts.filter(a => a.examID !== examID);

  rebuildResults();

  saveDatabase();

  renderTeacherDashboard();

  showToast("Exam deleted.");

}


/* Deletes one student's record (used by Results and Monitoring). */
async function deleteAttempt(attemptID) {

  const attempt =
    db.attempts.find(a => a.id === attemptID);

  if (!attempt) return;

  if (attempt.status === "ANSWERING") {

    showToast(
      "Terminate the student first, then delete the record."
    );

    return;

  }

  const exam =
    db.exams.find(e => e.id === attempt.examID);

  if (
    !confirm(
      `Delete ${attempt.studentName}'s record` +
      (exam ? ` for "${exam.title}"` : "") + "?\n\n" +
      "Their score and answers will be permanently removed. " +
      "This cannot be undone."
    )
  ) {

    return;

  }

  try {

    const { data, error } =
      await api.deleteAttempt(attemptID);

    if (error) throw error;

    if (!data || !data.length) {

      throw new Error("Nothing was deleted (check permissions).");

    }

    db.attempts =
      db.attempts.filter(a => a.id !== attemptID);

    rebuildResults();

    renderTeacherDashboard();

    showToast("Student record deleted.");

  } catch (error) {

    console.error("EXAMGUARD delete failed:", error);

    showToast("Could not delete the record. Try again.");

  }

}


async function terminateAttempt(attemptID) {

  const attempt =
    db.attempts.find(a => a.id === attemptID);

  if (!attempt) return;

  const waiting = attempt.status === "WAITING";

  if (
    !confirm(
      waiting
        ? `Remove ${attempt.studentName} from the waiting room?`
        : `Terminate ${attempt.studentName}'s examination?\n\n` +
          "Their saved answers will be scored and recorded."
    )
  ) {

    return;

  }

  try {

    const { error } =
      await api.rpc(
        "teacher_end_attempt",
        { p_attempt_id: attemptID }
      );

    if (error) throw error;

    showToast(
      waiting
        ? "Student removed from the waiting room."
        : "Student examination terminated."
    );

    await refreshTeacher(false);

  } catch (error) {

    showToast(
      "Could not update the student. Try again."
    );

  }

}


/* =========================================================
   STUDENT JOIN
   ---------------------------------------------------------
   Students never download the question bank or the answer
   key. Everything goes through server functions that only
   hand out the student's own exam paper (without answers)
   and do the scoring on the server.
   ========================================================= */

const JOIN_ERRORS = {

  not_found:
    "Exam code not found. Check the code and try again.",

  closed:
    "This examination is currently closed.",

  name_required:
    "Please enter your name.",

  no_questions:
    "This examination has no questions."

};

const START_ERRORS = {

  not_started:
    "Your teacher has not started the exam yet. Please wait.",

  closed:
    "This examination has been closed by your teacher.",

  no_questions:
    "This examination has no questions."

};


async function joinExam() {

  const message = el("joinMessage");

  if (!api.ready) {

    message.textContent = SERVER_UNAVAILABLE;

    return;

  }

  const code =
    el("joinExamCode")
      .value
      .trim()
      .toUpperCase();

  const surname =
    el("studentSurname")
      .value
      .trim();

  const givenName =
    el("studentGivenName")
      .value
      .trim();

  const middleInitial =
    el("studentMiddleInitial")
      .value
      .trim();

  const suffix =
    el("studentSuffix")
      .value
      .trim();

  const sex =
    el("studentSex")
      .value;

  if (!code) {

    message.textContent =
      "Please enter the exam code.";

    return;

  }

  if (!surname || !givenName) {

    message.textContent =
      "Please enter your surname and given name.";

    return;

  }

  if (!sex) {

    message.textContent =
      "Please select your sex.";

    return;

  }

  const studentName =
    [
      `${surname}, ${givenName}`,
      middleInitial,
      suffix
    ]
      .filter(Boolean)
      .join(" ");

  const button =
    document.querySelector(
      "#studentJoinScreen .primary-btn"
    );

  button.disabled = true;

  message.textContent = "";

  try {

    const { data, error } =
      await api.rpc(
        "join_exam",
        {
          p_code: code,
          p_name: studentName,
          p_sex: sex,
          p_surname: surname,
          p_given_name: givenName,
          p_middle_initial: middleInitial,
          p_suffix: suffix
        }
      );

    if (error) throw error;

    setNetworkStatus("online");

    if (data.error) {

      message.textContent =
        JOIN_ERRORS[data.error] ||
        "Could not join this examination.";

      return;

    }

    currentExam = {
      title: data.title,
      duration: data.duration
    };

    currentAttempt = {
      id: data.attempt_id,
      studentName,
      sex,
      status: "WAITING",
      answers: []
    };

    examEnding = false;

    pollFailures = 0;

    renderReadyScreen();

    updateReadyState(data);

    showScreen("studentReadyScreen");

    startStudentPolling();

  } catch (error) {

    console.error("EXAMGUARD join failed:", error);

    setNetworkStatus("offline");

    message.textContent =
      "Could not reach the exam server. " +
      "Check your internet connection and try again.";

  } finally {

    button.disabled = false;

  }

}


function renderReadyScreen() {

  readyState = null;

  el("readyExamTitle").textContent =
    currentExam.title;

  el("readyStudent").textContent =
    currentAttempt.studentName;

  el("readyMessage").textContent = "";

}


/* Keeps the waiting-room screen in step with the teacher. */
function updateReadyState(info) {

  if (!currentAttempt || !info) return;

  const banner = el("readyBanner");
  const title = el("readyBannerTitle");
  const text = el("readyBannerText");
  const button = el("readyStartBtn");

  let state = "waiting";

  if (info.exam_status !== "OPEN") {

    state = "closed";

  } else if (info.started) {

    state = "started";

  }

  el("readyExamTitle").textContent = info.title;

  el("readyQuestions").textContent = info.question_count;

  el("readyDuration").textContent = info.duration;

  el("readyPoints").textContent = info.total_points;

  el("readyRandomNote")
    .classList.toggle("hidden", !info.randomize);

  banner.className = "ready-banner " + state;

  el("readyEyebrow").textContent =
    state === "started"
      ? "READY TO BEGIN"
      : state === "closed"
        ? "EXAM CLOSED"
        : "WAITING ROOM";

  if (state === "waiting") {

    const inRoom = info.waiting_count || 1;

    title.textContent =
      "Waiting for your teacher to start";

    text.textContent =
      `${inRoom} student${inRoom === 1 ? "" : "s"} in the ` +
      "waiting room. This page unlocks automatically " +
      "when the exam begins.";

    button.disabled = true;

    button.textContent = "⏳ WAITING FOR TEACHER…";

  } else if (state === "started") {

    title.textContent =
      "Your teacher has started the exam";

    text.textContent =
      "Press Start Exam when you are ready. " +
      "Your timer begins when you press it.";

    button.disabled = false;

    button.textContent = "▶ START EXAM";

  } else {

    title.textContent =
      "This examination is closed";

    text.textContent =
      "Your teacher has closed this exam.";

    button.disabled = true;

    button.textContent = "EXAM CLOSED";

  }

  if (state !== readyState) {

    if (state === "started" && readyState === "waiting") {

      showToast("Your teacher has started the exam.");

    }

    el("readyMessage").textContent = "";

    readyState = state;

  }

}


/* ---------- keeping in touch with the server ---------- */

function startStudentPolling() {

  stopStudentPolling();

  studentPollTimer =
    setInterval(
      pollStudent,
      CONFIG.STUDENT_POLL_MS
    );

}


function stopStudentPolling() {

  clearInterval(studentPollTimer);

  studentPollTimer = null;

}


/* Every few seconds: "I'm still here" + ask what changed. */
async function pollStudent() {

  if (!currentAttempt || examEnding || pollBusy) return;

  pollBusy = true;

  if (pendingAnswers.size) flushAnswers();

  try {

    const { data, error } =
      await api.rpc(
        "poll_attempt",
        { p_attempt_id: currentAttempt.id }
      );

    if (error) throw error;

    pollFailures = 0;

    setNetworkStatus("online");

    handlePollResult(data);

  } catch (error) {

    pollFailures++;

    setNetworkStatus("offline");

    if (pollFailures === 3) {

      showToast("Connection problem. Trying again…");

    }

  } finally {

    pollBusy = false;

  }

}


function handlePollResult(info) {

  if (!currentAttempt || !info) return;

  if (info.status === "REMOVED") {

    endStudentSession(
      currentAttempt.status === "ANSWERING"
        ? "Your examination is no longer available."
        : "You are no longer in the waiting room. " +
          "Please join again."
    );

    return;

  }

  if (info.status === "WAITING") {

    updateReadyState(info);

    return;

  }

  if (info.status === "ANSWERING") {

    /* the server keeps the real clock */
    if (typeof info.remaining_seconds === "number") {

      examEndsAt =
        Date.now() + info.remaining_seconds * 1000;

    }

    return;

  }

  /* SUBMITTED or EXITED on the server */

  if (currentAttempt.status === "WAITING") {

    endStudentSession(
      info.reason === "TEACHER"
        ? "Your teacher removed you from the waiting room."
        : "You are no longer in the waiting room."
    );

    return;

  }

  finishStudentAttempt(info);

}


/* Leaves the waiting room and removes the student from it. */
function leaveLobby() {

  stopStudentPolling();

  if (
    currentAttempt &&
    currentAttempt.status === "WAITING"
  ) {

    sendLeaveBeacon(currentAttempt.id);

    currentAttempt = null;

    currentExam = null;

    readyState = null;

  }

}


function backToJoin() {

  leaveLobby();

  showStudentJoin();

}


function endStudentSession(message) {

  clearInterval(timerInterval);

  stopStudentPolling();

  currentAttempt = null;

  currentExam = null;

  studentQuestions = [];

  pendingAnswers.clear();

  examEnding = false;

  readyState = null;

  showScreen("homeScreen");

  if (message) showToast(message);

}


/* ---------- start ---------- */

async function startExam() {

  if (
    !currentAttempt ||
    currentAttempt.status !== "WAITING"
  ) {

    showStudentJoin();

    return;

  }

  if (startingExam) return;

  const message = el("readyMessage");

  const button = el("readyStartBtn");

  startingExam = true;

  button.disabled = true;

  message.textContent = "";

  try {

    const { data, error } =
      await api.rpc(
        "start_attempt",
        { p_attempt_id: currentAttempt.id }
      );

    if (error) throw error;

    if (data.error) {

      if (
        data.error === "removed" ||
        data.error === "ended"
      ) {

        endStudentSession(
          "You are no longer in this examination."
        );

        return;

      }

      message.textContent =
        START_ERRORS[data.error] ||
        "Could not start the examination.";

      pollStudent();

      return;

    }

    studentQuestions = data.paper;

    currentAttempt.answers = data.answers;

    currentAttempt.status = "ANSWERING";

    pendingAnswers.clear();

    currentQuestionIndex = 0;

    examEnding = false;

    submitting = false;

    el("studentExamTitle").textContent =
      currentExam.title;

    el("studentExamStudent").textContent =
      currentAttempt.studentName;

    showScreen("studentExamScreen");

    startExamTimer(data.remaining_seconds);

    renderStudentQuestion();

  } catch (error) {

    console.error("EXAMGUARD start failed:", error);

    message.textContent =
      "Could not reach the exam server. Try again.";

  } finally {

    startingExam = false;

    if (
      currentAttempt &&
      currentAttempt.status === "WAITING"
    ) {

      button.disabled = false;

    }

  }

}


/* =========================================================
   STUDENT EXAMINATION
   ========================================================= */

function startExamTimer(
  totalSeconds
) {

  clearInterval(
    timerInterval
  );


  examEndsAt =
    Date.now() +
    totalSeconds * 1000;

  lastTick = Date.now();


  function tick() {

    const now = Date.now();

    /* the timer froze: the phone was asleep or the app was
       in the background without the browser telling us */
    if (now - lastTick > CONFIG.RESUME_GAP_MS) {

      endExamForLeaving();

      return;

    }

    lastTick = now;


    const remaining =
      Math.max(
        0,
        Math.ceil(
          (
            examEndsAt -
            now
          ) / 1000
        )
      );


    const minutes =
      Math.floor(
        remaining / 60
      );


    const seconds =
      remaining % 60;


    el("examTimer").textContent =

      `${String(minutes).padStart(2,"0")}:` +
      `${String(seconds).padStart(2,"0")}`;


    /* keeps trying every second until the server confirms */
    if (
      remaining <= 0
    ) {

      submitExam(
        true
      );

    }

  }


  tick();


  timerInterval =
    setInterval(
      tick,
      1000
    );

}


let identSaveTimer = null;

function renderStudentQuestion() {

  if (!currentAttempt) {
    return;
  }


  const question =
    studentQuestions[
      currentQuestionIndex
    ];


  if (!question) {
    return;
  }


  const selected =
    currentAttempt.answers[
      currentQuestionIndex
    ];


  const total =
    studentQuestions.length;


  const questionNumber =
    currentQuestionIndex + 1;


  el("currentQuestionLabel").textContent =
    `QUESTION ${questionNumber}`;


  el("currentQuestion").textContent =
    question.text;


  el("questionNumber").textContent =
    `Question ${questionNumber} of ${total}`;


  const answered =
    currentAttempt.answers.filter(
      answer =>
        answer !== null
    ).length;


  el("answeredNumber").textContent =
    `${answered} Answered`;


  el("navCounter").textContent =
    `${questionNumber} / ${total}`;


  el("examProgress").style.width =
    `${questionNumber / total * 100}%`;


  const type = questionTypeOf(question);

  if (type === "IDENTIFICATION") {

    el("studentChoices").innerHTML = `

      <input
        type="text"
        id="identInput"
        class="ident-input"
        placeholder="Type your answer here"
        maxlength="200"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        value="${escapeHTML(selected ?? "")}"
      >

      <p class="ident-hint">
        Your answer is saved automatically as you type.
      </p>

    `;

    const input = el("identInput");

    const saveTyped = () => {

      if (examEnding) return;

      const index = currentQuestionIndex;

      const value = input.value.trim();

      currentAttempt.answers[index] =
        value === "" ? null : value;

      pendingAnswers.add(index);

      /* update the counter without redrawing (keeps the cursor) */
      el("answeredNumber").textContent =
        `${currentAttempt.answers.filter(a => a !== null).length} Answered`;

      clearTimeout(identSaveTimer);

      identSaveTimer =
        setTimeout(flushAnswers, 500);

    };

    input.oninput = saveTyped;

    /* save immediately when leaving the box */
    input.onblur = () => {

      clearTimeout(identSaveTimer);

      flushAnswers();

    };

  } else {

    el("studentChoices").innerHTML =
      Object.entries(
        question.choices
      ).map(
        ([letter,text]) => `

          <label
            class="student-choice
            ${selected === letter
              ? "selected"
              : ""}"
          >

            <input
              type="radio"
              name="studentAnswer"
              value="${letter}"
              ${selected === letter
                ? "checked"
                : ""}
            >

            <span>

              ${type === "TRUE_FALSE"
                ? ""
                : `<strong>${letter}.</strong>`}

              ${escapeHTML(text)}

            </span>

          </label>

        `
      ).join("");

  }


  document
    .querySelectorAll(
      'input[name="studentAnswer"]'
    )
    .forEach(
      radio => {

        radio.onchange =
          function() {

            if (examEnding) return;

            currentAttempt
              .answers[
                currentQuestionIndex
              ] =
              this.value;

            /* saved to the server right away */
            pendingAnswers.add(
              currentQuestionIndex
            );

            flushAnswers();

            renderStudentQuestion();

          };

      }
    );


  el("nextQuestionBtn").classList.toggle(
    "hidden",
    currentQuestionIndex ===
    total - 1
  );


  el("submitExamBtn").classList.toggle(
    "hidden",
    currentQuestionIndex !==
    total - 1
  );

}


/* Sends every answer that the server has not confirmed yet.
   Returns one shared promise so submitExam() can wait for it. */
function flushAnswers() {

  if (flushPromise) return flushPromise;

  flushPromise =
    (async () => {

      try {

        while (
          pendingAnswers.size &&
          currentAttempt &&
          !examEnding
        ) {

          const index =
            pendingAnswers.values().next().value;

          const answer =
            currentAttempt.answers[index];

          const { data, error } =
            await api.rpc(
              "save_answer",
              {
                p_attempt_id: currentAttempt.id,
                p_index: index,
                p_answer: answer
              }
            );

          if (error) throw error;

          /* the exam already ended on the server */
          if (data.status !== "ANSWERING") {

            pendingAnswers.clear();

            pollStudent();

            break;

          }

          /* only forget it if the student did not change it again */
          if (
            currentAttempt &&
            currentAttempt.answers[index] === answer
          ) {

            pendingAnswers.delete(index);

          }

        }

      } catch (error) {

        /* the next heartbeat tries again */

      } finally {

        flushPromise = null;

      }

    })();

  return flushPromise;

}


/* =========================================================
   QUESTION NAVIGATION
   ========================================================= */

function previousQuestion() {

  if (
    currentQuestionIndex <= 0
  ) {

    return;

  }


  currentQuestionIndex--;

  renderStudentQuestion();

}


function nextQuestion() {

  if (!currentAttempt) {
    return;
  }


  if (
    currentQuestionIndex >=
    studentQuestions.length - 1
  ) {

    return;

  }


  currentQuestionIndex++;

  renderStudentQuestion();

}


/* =========================================================
   SUBMISSION
   ========================================================= */

async function submitExam(
  automatic = false
) {

  if (
    !currentAttempt ||
    currentAttempt.status !== "ANSWERING" ||
    examEnding ||
    submitting
  ) {

    return;

  }


  if (
    !automatic
  ) {

    guardPaused = true;

    const confirmed =
      confirm(
        "Are you sure you want to submit your examination?"
      );

    guardPaused = false;

    lastTick = Date.now();


    if (!confirmed) {
      return;
    }

  }


  submitting = true;

  try {

    await flushAnswers();

    if (pendingAnswers.size) {

      throw new Error("unsaved answers");

    }

    if (!currentAttempt) return;

    const { data, error } =
      await api.rpc(
        "submit_attempt",
        {
          p_attempt_id: currentAttempt.id,
          p_reason:
            automatic
              ? "TIME_UP"
              : "SUBMITTED"
        }
      );

    if (error) throw error;

    handlePollResult(data);

  } catch (error) {

    console.error("EXAMGUARD submit failed:", error);

    showToast(
      automatic
        ? "Connection problem. Trying to submit again…"
        : "Could not submit. Check your connection and try again."
    );

  } finally {

    submitting = false;

  }

}


/* The server has ended the attempt (submitted, stopped...). */
function finishStudentAttempt(info) {

  examEnding = true;

  clearInterval(timerInterval);

  stopStudentPolling();

  const name = currentAttempt.studentName;

  currentAttempt = null;

  currentExam = null;

  studentQuestions = [];

  pendingAnswers.clear();

  if (info.status === "SUBMITTED") {

    showSubmittedScreen(
      name,
      info.score,
      info.total
    );

  } else {

    showStoppedScreen(info.reason);

  }

}


function showSubmittedScreen(name, score, total) {

  const percentage =
    total > 0
      ? Math.round(score / total * 100)
      : 0;

  el("studentResultIcon").className = "result-icon";

  el("studentResultIcon").textContent = "✓";

  el("studentResultEyebrow").textContent =
    "EXAMINATION SUBMITTED";

  el("studentResultTitle").textContent =
    "Submission Recorded";

  el("studentResultMessage").textContent =
    `${name}, ` +
    "your examination has been recorded successfully.";

  el("studentScoreBox").classList.remove("hidden");

  el("studentFinalScore").textContent =
    `${score}/${total}`;

  el("studentFinalPercentage").textContent =
    `${percentage}%`;

  showScreen("studentResultScreen");

}


const STOPPED_MESSAGES = {

  LEFT_SCREEN:
    "You left the exam screen, so your examination was " +
    "stopped automatically. Only the answers you gave " +
    "before leaving were recorded.",

  SIGNAL_LOST:
    "Your connection was lost for too long, so your " +
    "examination was stopped. The answers saved before " +
    "that were recorded.",

  TEACHER:
    "Your teacher ended your examination. The answers " +
    "you gave until then were recorded."

};


function showStoppedScreen(reason) {

  el("studentResultIcon").className =
    "result-icon stopped";

  el("studentResultIcon").textContent = "!";

  el("studentResultEyebrow").textContent =
    "EXAMINATION STOPPED";

  el("studentResultTitle").textContent =
    "Examination Ended";

  el("studentResultMessage").textContent =
    STOPPED_MESSAGES[reason] ||
    "Your examination was stopped. " +
    "The answers you gave were recorded.";

  el("studentScoreBox").classList.add("hidden");

  showScreen("studentResultScreen");

}


/* =========================================================
   LEAVE-SCREEN GUARD
   ---------------------------------------------------------
   Minimizing the browser, switching apps or tabs, going to
   the home screen or locking the phone ends the exam at once.
   Answers are saved the moment they are tapped, so the record
   only ever contains what the student answered BEFORE leaving.
   ========================================================= */

function examIsRunning() {

  return (
    !!currentAttempt &&
    currentAttempt.status === "ANSWERING" &&
    !examEnding &&
    isScreenActive("studentExamScreen")
  );

}


/* Tells the server even while the page is being hidden. */
function sendLeaveBeacon(attemptID) {

  api.sendLeaveBeacon(attemptID);

}


/* Normal call, retried when the phone wakes up or reconnects. */
async function confirmLeave() {

  if (!pendingLeaveID || !api.ready) return;

  try {

    const { error } =
      await api.rpc(
        "leave_attempt",
        { p_attempt_id: pendingLeaveID }
      );

    if (!error) pendingLeaveID = null;

  } catch (error) {

    /* will be retried */

  }

}


function endExamForLeaving() {

  if (guardPaused || !examIsRunning()) return;

  examEnding = true;

  clearInterval(timerInterval);

  stopStudentPolling();

  pendingLeaveID = currentAttempt.id;

  sendLeaveBeacon(pendingLeaveID);

  confirmLeave();

  currentAttempt = null;

  currentExam = null;

  studentQuestions = [];

  pendingAnswers.clear();

  showStoppedScreen("LEFT_SCREEN");

}


function handleVisibilityChange() {

  if (document.hidden) {

    endExamForLeaving();

  } else {

    confirmLeave();

    /* teacher came back to the tab: catch up right away */
    if (
      teacherSignedIn &&
      isScreenActive("teacherDashboard")
    ) {

      refreshTeacher(false);

    }

  }

}


function handlePageHide() {

  if (examIsRunning()) {

    endExamForLeaving();

    return;

  }

  if (
    currentAttempt &&
    currentAttempt.status === "WAITING"
  ) {

    leaveLobby();

  }

}


/* =========================================================
   RESULTS
   ========================================================= */

function renderResults() {

  const body =
    document.getElementById(
      "resultsBody"
    );


  if (!db.results.length) {

    body.innerHTML = `

      <tr>

        <td
          colspan="7"
          style="
            text-align:center;
            color:#667085;
          "
        >
          No examination results yet.
        </td>

      </tr>

    `;

    return;

  }


  body.innerHTML =
    db.results.map(
      result => `

        <tr>

          <td>
            <strong>
              ${escapeHTML(
                result.studentName
              )}
            </strong>
          </td>

          <td>
            ${escapeHTML(
              result.examTitle
            )}
          </td>

          <td>
            ${result.score}/${result.total}
          </td>

          <td>
            <strong>
              ${result.percentage}%
            </strong>
          </td>

          <td>

            <span
              class="status ${resultStatus(result).cls}"
            >
              ${resultStatus(result).label}
            </span>

          </td>

          <td>
            ${new Date(
              result.submittedAt
            ).toLocaleString()}
          </td>

          <td>
            <button
              class="mini-btn"
              onclick="openItemBreakdown('${result.id}')"
            >
              🔍 View
            </button>
            <button
              class="mini-btn red"
              onclick="deleteAttempt('${result.id}')"
            >
              🗑️ Delete
            </button>
          </td>

        </tr>

      `
    ).join("");

}


/* =========================================================
   PER-STUDENT ITEM BREAKDOWN
   ========================================================= */

function openItemBreakdown(resultID) {

  const result =
    db.results.find(r => r.id === resultID);

  if (!result) {

    showToast("That result is no longer available.");
    return;

  }

  const paper = result.paper || [];
  const key = result.key || [];
  const answers = result.answers || [];

  document.getElementById("breakdownTitle").textContent =
    `${result.studentName} — ${result.examTitle}`;

  document.getElementById("breakdownSummary").textContent =
    `Score: ${result.score}/${result.total}  (${result.percentage}%)`;

  const body = document.getElementById("breakdownBody");

  if (!paper.length) {

    body.innerHTML =
      `<div class="empty-state">
        No item-level data was saved for this attempt
        (it may predate this feature).
      </div>`;

  } else {

    body.innerHTML =
      paper.map((q, i) => {

        const studentAns = answers[i];
        const correctAns = key[i] ? key[i].c : null;
        const pts = key[i] ? key[i].p : 1;
        const type = questionTypeOf(q);
        const wasAnswered =
          studentAns !== null && studentAns !== undefined;
        const isCorrect =
          answerMatches(
            studentAns,
            key[i] ? { c: key[i].c, t: type } : null
          );

        let detail;

        if (type === "IDENTIFICATION") {

          detail = `
            <p class="${isCorrect ? "bd-key" : "bd-pick"}">
              Student's answer:
              <strong>${
                wasAnswered ? escapeHTML(studentAns) : "(none)"
              }</strong>
              ${isCorrect ? " ✅" : ""}
            </p>
            <p class="bd-key">
              Accepted answer(s):
              ${escapeHTML(
                String(correctAns ?? "")
                  .split(";")
                  .map(a => a.trim())
                  .filter(Boolean)
                  .join(" / ")
              )}
            </p>`;

        } else {

          const letters =
            type === "TRUE_FALSE" ? ["A", "B"] : ["A", "B", "C", "D"];

          detail = letters.map(letter => {

            const isStudentPick = studentAns === letter;
            const isCorrectPick = correctAns === letter;

            let tag = "";
            if (isCorrectPick) tag += " ✅ correct answer";
            if (isStudentPick && !isCorrectPick) tag += " ⬅ student's answer";
            if (isStudentPick && isCorrectPick) tag = " ✅ student's answer (correct)";

            const label =
              type === "TRUE_FALSE"
                ? escapeHTML(q.choices[letter] || displayAnswer(letter, type))
                : `${letter}. ${escapeHTML(q.choices[letter])}`;

            return `<p class="${
              isCorrectPick ? "bd-key" : isStudentPick ? "bd-pick" : ""
            }">${label}${tag}</p>`;

          }).join("");

        }

        return `
          <div class="item-card breakdown-item ${
            isCorrect ? "bd-correct" : "bd-wrong"
          }">

            <h4>
              ${i + 1}. ${escapeHTML(q.text)}
              <span class="status ${
                isCorrect ? "SUBMITTED" : "INTERRUPTED"
              }">
                ${
                  !wasAnswered
                    ? "NO ANSWER"
                    : isCorrect
                      ? "CORRECT"
                      : "WRONG"
                }
              </span>
            </h4>

            <p>
              <span class="status SUBMITTED">${
                QUESTION_TYPES[type]
              }</span>
            </p>

            ${detail}

            <p><strong>${pts} point(s)</strong></p>

          </div>
        `;

      }).join("");

  }

  document.getElementById("breakdownOverlay")
    .classList.remove("hidden");

  document.body.classList.add("modal-open");

}


function closeItemBreakdown() {

  document.getElementById("breakdownOverlay")
    .classList.add("hidden");

  document.body.classList.remove("modal-open");

}


/* =========================================================
   CSV EXPORT
   ========================================================= */

function downloadResults() {

  if (!db.results.length) {

    showToast(
      "There are no results to download."
    );

    return;

  }

  /* Build a stable, per-exam column order for item-level answers.
     Reference order/content comes from whichever attempt in that
     exam we see first, then every other attempt's answers are
     matched back to it by question id (safe even if randomize
     shuffled each student's question order). */
  const examColumns = new Map(); // examID -> [{qID, correct}]

  db.results.forEach(result => {

    if (!examColumns.has(result.examID)) {
      examColumns.set(result.examID, []);
    }

    const cols = examColumns.get(result.examID);
    const seen = new Set(cols.map(c => c.qID));

    (result.questionIDs || []).forEach((qID, i) => {

      if (seen.has(qID)) return;

      cols.push({
        qID,
        correct: result.key[i] ? result.key[i].c : ""
      });

      seen.add(qID);

    });

  });

  const baseHeaders = [
    "Student",
    "Exam",
    "Score",
    "Total",
    "Percentage",
    "Status",
    "Time Submitted"
  ];

  /* Item columns are only added for the exam that appears first
     among the results, one block per exam, in first-seen order. */
  const examOrder = [...examColumns.keys()];

  const itemHeaders = [];
  const itemHeaderMap = []; // parallel: {examID, qID}

  examOrder.forEach(examID => {

    const exam = db.results.find(r => r.examID === examID);
    const label = exam ? exam.examTitle : examID;

    examColumns.get(examID).forEach((col, i) => {

      itemHeaders.push(
        `${label} — Q${i + 1} (Correct: ${col.correct})`
      );

      itemHeaderMap.push({ examID, qID: col.qID });

    });

  });

  const rows = [
    [...baseHeaders, ...itemHeaders]
  ];


  db.results.forEach(
    result => {

      const base = [

        result.studentName,

        result.examTitle,

        result.score,

        result.total,

        result.percentage + "%",

        resultStatus(result).label,

        new Date(
          result.submittedAt
        ).toLocaleString()

      ];

      const items = itemHeaderMap.map(col => {

        if (col.examID !== result.examID) return "";

        const idx = (result.questionIDs || []).indexOf(col.qID);

        if (idx === -1) return "";

        const studentAns = result.answers[idx];
        const correctAns =
          result.key[idx] ? result.key[idx].c : null;

        if (studentAns === null || studentAns === undefined) {
          return "No answer";
        }

        const keyEntry =
          result.key[idx]
            ? { c: result.key[idx].c, t: result.key[idx].t }
            : null;

        const shown =
          displayAnswer(studentAns, keyEntry && keyEntry.t);

        return answerMatches(studentAns, keyEntry)
          ? `${shown} (correct)`
          : `${shown} (wrong)`;

      });

      rows.push([...base, ...items]);

    }
  );


  const csv =
    rows.map(
      row =>
        row.map(
          value =>
            `"${String(value)
              .replace(/"/g,'""')}"`
        ).join(",")
    ).join("\n");


  const blob =
    new Blob(
      ["\ufeff" + csv],
      {
        type:
          "text/csv;charset=utf-8;"
      }
    );


  const url =
    URL.createObjectURL(
      blob
    );


  const link =
    document.createElement(
      "a"
    );


  link.href = url;

  link.download =
    "EXAMGUARD_Results.csv";


  link.click();


  URL.revokeObjectURL(
    url
  );


  showToast(
    "Results downloaded."
  );

}


/* =========================================================
   ITEM ANALYSIS (CSV) — a simple correctness matrix: each
   student's name against each item number, marked 1 if the
   student answered that item correctly or 0 otherwise (wrong
   or unanswered).
   ========================================================= */

/* Builds the item-analysis matrix for one exam's results:
   students grouped under MALE / FEMALE section rows (alphabetical
   within each group), a running "No." column, and one 0/1 column
   per item — matching the class-record layout teachers use. */
function buildItemAnalysisBlock(examTitle, examResults) {

  /* Canonical item order: first-seen question order, same
     approach as downloadResults(), so shuffled/randomized
     papers still line up by question id. */
  const items = []; // [{qID}]
  const seen = new Set();

  examResults.forEach(r => {
    (r.questionIDs || []).forEach(qID => {
      if (seen.has(qID)) return;
      seen.add(qID);
      items.push({ qID });
    });
  });

  const itemCount = items.length;

  /* Per-student correctness matrix: 1 correct, 0 for anything
     else (wrong answer or no response). Name is built as
     "Surname, Given name, Suffix, Middle initial" from the
     individual fields captured at join time; older attempts
     that predate those fields fall back to the stored full name. */
  const students = examResults.map(r => {

    const marks = items.map(col => {

      const idx = (r.questionIDs || []).indexOf(col.qID);
      if (idx === -1) return 0;

      const studentAns = r.answers[idx];
      const correctAns = r.key[idx] ? r.key[idx].c : null;

      return answerMatches(studentAns, r.key[idx]) ? 1 : 0;

    });

    const name =
      r.surname || r.givenName
        ? [r.surname, r.givenName, r.suffix, r.middleInitial]
            .filter(Boolean)
            .join(", ")
        : r.studentName;

    return { name, sex: r.sex || "", marks };

  });

  /* Group by sex — Male section first, then Female, then
     anything unspecified — alphabetical by name within a group
     (name is already "Surname, Given Name", so a plain string
     sort lines up alphabetically by surname). */
  const groups = [
    { label: "MALE", list: [] },
    { label: "FEMALE", list: [] },
    { label: "UNSPECIFIED", list: [] }
  ];

  students.forEach(s => {
    const group =
      s.sex === "Male" ? groups[0] :
      s.sex === "Female" ? groups[1] :
      groups[2];
    group.list.push(s);
  });

  groups.forEach(
    g => g.list.sort((a, b) => a.name.localeCompare(b.name))
  );

  /* ---- rows ---- */
  const rows = [];

  rows.push([`ITEM ANALYSIS — ${examTitle}`]);

  const header = ["No.", "Name of Learners"];
  for (let i = 1; i <= itemCount; i++) header.push(i);
  rows.push(header);

  let no = 0;

  groups.forEach(group => {

    if (!group.list.length) return;

    rows.push(["", group.label]);

    group.list.forEach(s => {
      no++;
      rows.push([no, s.name, ...s.marks]);
    });

  });

  rows.push([]);

  return { rows };

}


function downloadItemAnalysis() {

  if (!db.results.length) {

    showToast(
      "There are no results to analyze yet."
    );

    return;

  }

  /* Group results by exam, preserving first-seen exam order —
     one matrix per exam. */
  const examOrder = [];
  const byExam = new Map();

  db.results.forEach(r => {
    if (!byExam.has(r.examID)) {
      byExam.set(r.examID, []);
      examOrder.push(r.examID);
    }
    byExam.get(r.examID).push(r);
  });

  const rows = [];

  examOrder.forEach(examID => {

    const examResults = byExam.get(examID);
    const examTitle = examResults[0].examTitle;

    const block = buildItemAnalysisBlock(examTitle, examResults);

    rows.push(...block.rows);

  });


  const csv =
    rows.map(
      row =>
        row.map(
          value =>
            `"${String(value)
              .replace(/"/g,'""')}"`
        ).join(",")
    ).join("\n");


  const blob =
    new Blob(
      ["\ufeff" + csv],
      { type: "text/csv;charset=utf-8;" }
    );


  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "EXAMGUARD_Item_Analysis.csv";
  link.click();

  URL.revokeObjectURL(url);

  showToast(
    "Item analysis downloaded."
  );

}


/* =========================================================
   PRINT / PDF
   ========================================================= */

function printResults() {

  if (!db.results.length) {

    showToast(
      "There are no results to print."
    );

    return;

  }


  const rows =
    db.results.map(
      result => `

        <tr>

          <td>
            ${escapeHTML(
              result.studentName
            )}
          </td>

          <td>
            ${escapeHTML(
              result.examTitle
            )}
          </td>

          <td>
            ${result.score}/${result.total}
          </td>

          <td>
            ${result.percentage}%
          </td>

          <td>
            ${resultStatus(result).label}
          </td>

          <td>
            ${new Date(
              result.submittedAt
            ).toLocaleString()}
          </td>

        </tr>

      `
    ).join("");


  const printWindow =
    window.open(
      "",
      "_blank"
    );


  printWindow.document.write(`

    <!DOCTYPE html>

    <html>

    <head>

      <title>
        EXAMGUARD Examination Results
      </title>

      <style>

        body {
          font-family: Arial;
          padding: 30px;
        }

        h1 {
          margin-bottom: 5px;
        }

        p {
          color: #555;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 25px;
        }

        th,
        td {
          border: 1px solid #ccc;
          padding: 9px;
          text-align: left;
        }

        th {
          background: #f2f2f2;
        }

      </style>

    </head>

    <body>

      <h1>
        EXAMGUARD
      </h1>

      <p>
        Examination Results Report
      </p>

      <table>

        <thead>

          <tr>

            <th>
              Student
            </th>

            <th>
              Examination
            </th>

            <th>
              Score
            </th>

            <th>
              Percentage
            </th>

            <th>
              Status
            </th>

            <th>
              Submitted
            </th>

          </tr>

        </thead>

        <tbody>

          ${rows}

        </tbody>

      </table>

    </body>

    </html>

  `);


  printWindow.document.close();

  printWindow.focus();

  printWindow.print();

}



/* =========================================================
   KEYBOARD SHORTCUT
   ========================================================= */

document.addEventListener(
  "keydown",
  event => {

    if (
      event.key === "Escape"
    ) {

      const overlay =
        document.getElementById("breakdownOverlay");

      if (
        overlay &&
        !overlay.classList.contains("hidden")
      ) {

        closeItemBreakdown();
        return;

      }

      if (
        document
          .getElementById(
            "homeScreen"
          )
          .classList
          .contains("active")
      ) {

        return;

      }

    }

  }
);



/* =========================================================
   INITIALIZE
   ========================================================= */

document.addEventListener(
  "visibilitychange",
  handleVisibilityChange
);

window.addEventListener("pagehide", handlePageHide);

/* Page Lifecycle API: the browser is about to freeze the page */
window.addEventListener("freeze", endExamForLeaving);

window.addEventListener("online", confirmLeave);

if (CONFIG.END_ON_WINDOW_BLUR) {

  window.addEventListener("blur", endExamForLeaving);

}

if (OFFLINE_MODE) {

  setNetworkStatus("online");

} else if (!sb) {

  setNetworkStatus("off");

  console.warn(
    "EXAMGUARD: Supabase is not set up. " +
    "Edit CONFIG at the top of script.js (see SETUP.md)."
  );

  setTimeout(() => {

    showToast(
      "Supabase is not set up yet. See SETUP.md."
    );

  }, 600);

}

console.log(
  "EXAMGUARD initialized successfully" +
  (OFFLINE_MODE ? " (offline / local network mode)." : ".")
);
