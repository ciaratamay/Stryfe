import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, orderBy, serverTimestamp, Timestamp,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});
enableIndexedDbPersistence(db).catch(() => {});

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._h);
  showToast._h = setTimeout(() => t.classList.remove("show"), 2200);
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "person";
}

function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function addMonthsKeepDay(date, n, day) {
  const d = new Date(date);
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, 28));
  return d;
}

function fmtRelative(date) {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function fmtDue(date, hasTime) {
  const opts = { month: "short", day: "numeric" };
  const dateStr = date.toLocaleDateString(undefined, opts);
  if (!hasTime) return dateStr;
  const timeStr = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${dateStr}, ${timeStr}`;
}

function freqSummary(freq) {
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  switch (freq.type) {
    case "once": return "One-off";
    case "daily": return "Every day";
    case "weekly": return "Every week";
    case "custom-days": return `Every ${freq.intervalDays} days`;
    case "custom-weeks": return `Every ${freq.intervalWeeks} weeks on ${weekdayNames[freq.weekday]}`;
    case "monthly": return `Monthly on the ${freq.monthDay}${ordinal(freq.monthDay)}`;
    default: return "";
  }
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function advanceDue(task) {
  const base = task.dueAt.toDate();
  const f = task.freq;
  switch (f.type) {
    case "once": return base;
    case "daily": return addDays(base, 1);
    case "weekly": return addDays(base, 7);
    case "custom-days": return addDays(base, f.intervalDays);
    case "custom-weeks": return addDays(base, f.intervalWeeks * 7);
    case "monthly": return addMonthsKeepDay(base, 1, f.monthDay);
    default: return addDays(base, 1);
  }
}

function isDue(task, now) {
  const due = task.dueAt.toDate();
  if (task.hasTime) return due.getTime() <= now.getTime();
  const dueDayStart = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const nowDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return dueDayStart.getTime() <= nowDayStart.getTime();
}

// ---------- state ----------
let currentUser = null;      // {uid, name, hint, email}
let profilesCache = {};      // uid -> {name, hint, email}
let sortedProfileUids = [];
let tasksById = {};
let unsubTasks = null;
let unsubLog = null;
let editingTaskId = null;
let selectedProfileForAuth = null;
let rolloverTimer = null;

function colorClassForUid(uid) {
  if (!uid) return "tag-unassigned";
  const idx = sortedProfileUids.indexOf(uid);
  return idx % 2 === 0 ? "tag-a" : "tag-b";
}

// ---------- profile fetch (works pre-auth: profiles are publicly readable) ----------
async function refreshProfilesCache() {
  const snap = await getDocs(collection(db, "profiles"));
  profilesCache = {};
  snap.forEach((d) => { profilesCache[d.id] = d.data(); });
  sortedProfileUids = Object.keys(profilesCache).sort();
}

async function renderProfilePicker() {
  await refreshProfilesCache();
  const list = $("profile-list");
  list.innerHTML = "";
  const uids = Object.keys(profilesCache);
  $("profile-list-empty").classList.toggle("hidden", uids.length > 0);
  uids.forEach((uid) => {
    const p = profilesCache[uid];
    const btn = document.createElement("button");
    btn.className = "profile-pick";
    btn.innerHTML = `<span class="profile-dot"></span>${escapeHtml(p.name)}`;
    btn.onclick = () => {
      selectedProfileForAuth = { uid, ...p };
      $("password-step-name").textContent = `Hi ${p.name}`;
      $("input-password").value = "";
      $("password-error").textContent = "";
      $("hint-display").classList.add("hidden");
      $("btn-send-reset").classList.toggle("hidden", !p.email);
      showAuthStep("password");
    };
    list.appendChild(btn);
  });
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function showAuthStep(step) {
  $("auth-step-pick").classList.toggle("hidden", step !== "pick");
  $("auth-step-password").classList.toggle("hidden", step !== "password");
  $("auth-step-create").classList.toggle("hidden", step !== "create");
}

// ---------- auth screen wiring ----------
on("btn-show-add-person", "click", () => {
  $("input-new-name").value = "";
  $("input-new-password").value = "";
  $("input-new-hint").value = "";
  $("input-new-email").value = "";
  $("create-error").textContent = "";
  showAuthStep("create");
});
on("btn-back-to-pick", "click", () => showAuthStep("pick"));
on("btn-back-to-pick-2", "click", () => showAuthStep("pick"));

on("btn-show-hint", "click", () => {
  const h = $("hint-display");
  h.textContent = selectedProfileForAuth.hint ? `Hint: ${selectedProfileForAuth.hint}` : "No hint was set for this profile.";
  h.classList.remove("hidden");
});

on("btn-send-reset", "click", async () => {
  if (!selectedProfileForAuth?.email) return;
  try {
    await sendPasswordResetEmail(auth, selectedProfileForAuth.email);
    showToast(`Reset email sent to ${selectedProfileForAuth.email}`);
  } catch (e) {
    $("password-error").textContent = "Couldn't send a reset email right now.";
  }
});

on("btn-sign-in", "click", () => doSignIn());
on("input-password", "keydown", (e) => { if (e.key === "Enter") doSignIn(); });

async function doSignIn() {
  const pw = $("input-password").value;
  if (!pw) { $("password-error").textContent = "Enter your password."; return; }
  $("btn-sign-in").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, selectedProfileForAuth.email, pw);
    $("password-error").textContent = "";
  } catch (e) {
    $("password-error").textContent = "That password doesn't match.";
  } finally {
    $("btn-sign-in").disabled = false;
  }
}

on("btn-create-person", "click", async () => {
  const name = $("input-new-name").value.trim();
  const password = $("input-new-password").value;
  const hint = $("input-new-hint").value.trim();
  const emailInput = $("input-new-email").value.trim();
  const err = $("create-error");
  err.textContent = "";

  if (!name) { err.textContent = "Enter a name."; return; }
  await refreshProfilesCache();
  const nameTaken = Object.values(profilesCache).some((p) => p.name.toLowerCase() === name.toLowerCase());
  if (nameTaken) { err.textContent = "That name's already set up — sign in as them instead, from the back screen."; return; }
  if (password.length < 6) { err.textContent = "Password needs to be at least 6 characters."; return; }

  const emailToUse = emailInput || `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}@household.local`;
  $("btn-create-person").disabled = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, emailToUse, password);
    await setDoc(doc(db, "profiles", cred.user.uid), {
      name,
      hint: hint || null,
      email: emailInput || null,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    if (e.code === "auth/email-already-in-use") err.textContent = "That email's already registered — try signing in instead.";
    else if (e.code === "auth/invalid-email") err.textContent = "That email address doesn't look right.";
    else err.textContent = "Couldn't create that profile — try again.";
  } finally {
    $("btn-create-person").disabled = false;
  }
});

on("btn-sign-out", "click", () => signOut(auth));

// ---------- auth state ----------
onAuthStateChanged(auth, async (user) => {
  if (user) {
    const snap = await getDoc(doc(db, "profiles", user.uid));
    if (!snap.exists()) { await signOut(auth); return; }
    currentUser = { uid: user.uid, ...snap.data() };
    $("me-badge").textContent = currentUser.name;
    await refreshProfilesCache();
    populateAssigneeSelect();
    populateDoneFilterSelect();
    showAppScreen();
    subscribeTasks();
    subscribeLog();
    startRollover();
  } else {
    teardown();
    showAuthScreen();
    showAuthStep("pick");
    renderProfilePicker();
  }
});

function showAuthScreen() {
  $("screen-auth").classList.remove("hidden");
  $("screen-app").classList.add("hidden");
}
function showAppScreen() {
  $("screen-auth").classList.add("hidden");
  $("screen-app").classList.remove("hidden");
}

function teardown() {
  if (unsubTasks) unsubTasks();
  if (unsubLog) unsubLog();
  if (rolloverTimer) clearInterval(rolloverTimer);
  tasksById = {};
  currentUser = null;
}

// ---------- selects ----------
function populateAssigneeSelect() {
  const sel = $("input-task-assignee");
  sel.innerHTML = '<option value="">Unassigned</option>';
  sortedProfileUids.forEach((uid) => {
    const opt = document.createElement("option");
    opt.value = uid;
    opt.textContent = profilesCache[uid].name;
    sel.appendChild(opt);
  });
}

function populateDoneFilterSelect() {
  const sel = $("filter-done");
  sel.innerHTML = '<option value="anyone">Anyone</option>';
  sortedProfileUids.forEach((uid) => {
    const opt = document.createElement("option");
    opt.value = uid;
    opt.textContent = profilesCache[uid].name;
    sel.appendChild(opt);
  });
}

function buildDoneBySelect(currentUid) {
  const sel = document.createElement("select");
  sel.className = "done-by-select";
  sortedProfileUids.forEach((uid) => {
    const opt = document.createElement("option");
    opt.value = uid;
    opt.textContent = profilesCache[uid].name;
    if (uid === currentUid) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

function buildAssigneeMiniSelect(task) {
  const sel = document.createElement("select");
  sel.className = "filter-select";
  sel.innerHTML = '<option value="">Unassigned</option>';
  sortedProfileUids.forEach((uid) => {
    const opt = document.createElement("option");
    opt.value = uid;
    opt.textContent = profilesCache[uid].name;
    if (task.assignedTo === uid) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.onchange = () => updateDoc(doc(db, "tasks", task.id), { assignedTo: sel.value || null });
  return sel;
}

// ---------- tasks subscription ----------
function subscribeTasks() {
  unsubTasks = onSnapshot(collection(db, "tasks"), (snap) => {
    tasksById = {};
    snap.forEach((d) => { tasksById[d.id] = { id: d.id, ...d.data() }; });
    rolloverIfNeeded();
    renderBoard();
    renderManage();
  }, () => showToast("Having trouble syncing right now."));
}

function subscribeLog() {
  const q = query(collection(db, "log"), orderBy("doneAt", "desc"));
  unsubLog = onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push(d.data()));
    renderLog(rows);
  });
}

function rolloverIfNeeded() {
  const now = new Date();
  Object.values(tasksById).forEach((task) => {
    if (task.done && task.freq.type !== "once" && isDue(task, now)) {
      updateDoc(doc(db, "tasks", task.id), { done: false, doneBy: null, doneAt: null }).catch(() => {});
    }
  });
}

function startRollover() {
  rolloverTimer = setInterval(() => { rolloverIfNeeded(); renderBoard(); }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { rolloverIfNeeded(); renderBoard(); }
  });
}

// ---------- board rendering ----------
on("filter-todo", "change", renderBoard);
on("filter-done", "change", renderBoard);

function renderBoard() {
  if (!currentUser) return;
  const now = new Date();
  const todoFilter = $("filter-todo").value;
  const doneFilter = $("filter-done").value;

  let todo = Object.values(tasksById).filter((t) => !t.done && isDue(t, now));
  if (todoFilter === "mine") todo = todo.filter((t) => !t.assignedTo || t.assignedTo === currentUser.uid);
  else if (todoFilter === "assigned-me") todo = todo.filter((t) => t.assignedTo === currentUser.uid);
  todo.sort((a, b) => a.dueAt.toDate() - b.dueAt.toDate());

  let done = Object.values(tasksById).filter((t) => t.done);
  if (doneFilter !== "anyone") done = done.filter((t) => t.doneBy === doneFilter);
  done.sort((a, b) => (b.doneAt?.toDate() ?? 0) - (a.doneAt?.toDate() ?? 0));

  const todoList = $("list-todo");
  todoList.innerHTML = "";
  $("todo-empty").classList.toggle("hidden", todo.length > 0);
  todo.forEach((t) => todoList.appendChild(renderTodoRow(t)));

  const doneList = $("list-done");
  doneList.innerHTML = "";
  $("done-empty").classList.toggle("hidden", done.length > 0);
  done.forEach((t) => doneList.appendChild(renderDoneRow(t)));
}

function renderTodoRow(task) {
  const li = document.createElement("li");
  li.className = "task-row";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "task-check";
  check.onchange = () => markDone(task);

  const main = document.createElement("div");
  main.className = "task-main";
  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.title;
  const meta = document.createElement("div");
  meta.className = "task-meta";
  const freqNote = document.createElement("span");
  freqNote.className = "freq-note";
  freqNote.textContent = `${freqSummary(task.freq)} · due ${fmtDue(task.dueAt.toDate(), task.hasTime)}`;
  meta.appendChild(buildAssigneeMiniSelect(task));
  main.appendChild(title);
  main.appendChild(meta);
  main.appendChild(freqNote);

  const editBtn = document.createElement("button");
  editBtn.className = "text-btn";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => openEditTaskModal(task);

  li.appendChild(check);
  li.appendChild(main);
  li.appendChild(editBtn);
  return li;
}

function renderDoneRow(task) {
  const li = document.createElement("li");
  li.className = "task-row";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "task-check";
  check.checked = true;
  check.onchange = () => unmarkDone(task);

  const main = document.createElement("div");
  main.className = "task-main";
  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.title;
  const meta = document.createElement("div");
  meta.className = "task-meta";
  const label = document.createElement("span");
  label.className = "freq-note";
  label.textContent = "Done by";
  meta.appendChild(label);
  meta.appendChild(buildDoneBySelect(task.doneBy));
  const when = document.createElement("span");
  when.className = "freq-note";
  when.textContent = task.doneAt ? fmtRelative(task.doneAt.toDate()) : "";
  meta.appendChild(when);

  meta.querySelector("select").onchange = (e) => {
    updateDoc(doc(db, "tasks", task.id), { doneBy: e.target.value });
  };

  main.appendChild(title);
  main.appendChild(meta);

  li.appendChild(check);
  li.appendChild(main);
  return li;
}

async function markDone(task) {
  const prevDueAt = task.dueAt;
  const nextDue = advanceDue(task);
  await updateDoc(doc(db, "tasks", task.id), {
    done: true,
    doneBy: currentUser.uid,
    doneAt: serverTimestamp(),
    dueAt: Timestamp.fromDate(nextDue),
    prevDueAt,
  });
  await addDoc(collection(db, "log"), {
    taskId: task.id,
    taskTitle: task.title,
    doneBy: currentUser.uid,
    doneByName: currentUser.name,
    doneAt: serverTimestamp(),
  });
  showToast("Marked done");
}

async function unmarkDone(task) {
  await updateDoc(doc(db, "tasks", task.id), {
    done: false,
    doneBy: null,
    doneAt: null,
    dueAt: task.prevDueAt || task.dueAt,
  });
}

// ---------- tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    ["board", "manage", "log"].forEach((t) => $(`tab-${t}`).classList.toggle("hidden", t !== tab));
    $("btn-add-task").classList.toggle("hidden", tab === "log");
  });
});

// ---------- manage tab ----------
function renderManage() {
  const list = $("list-manage");
  list.innerHTML = "";
  const all = Object.values(tasksById).sort((a, b) => a.title.localeCompare(b.title));
  $("manage-empty").classList.toggle("hidden", all.length > 0);
  all.forEach((task) => {
    const li = document.createElement("li");
    li.className = "manage-row";

    const main = document.createElement("div");
    main.className = "task-main";
    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = task.title;
    const meta = document.createElement("div");
    meta.className = "task-meta";
    const tag = document.createElement("span");
    tag.className = `tag ${colorClassForUid(task.assignedTo)}`;
    tag.textContent = task.assignedTo ? profilesCache[task.assignedTo]?.name ?? "?" : "Unassigned";
    const freqNote = document.createElement("span");
    freqNote.className = "freq-note";
    freqNote.textContent = `${freqSummary(task.freq)} · next ${fmtDue(task.dueAt.toDate(), task.hasTime)}${task.done ? " (currently done)" : ""}`;
    meta.appendChild(tag);
    meta.appendChild(freqNote);
    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "manage-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "text-btn";
    editBtn.textContent = "Edit";
    editBtn.onclick = () => openEditTaskModal(task);
    const delBtn = document.createElement("button");
    delBtn.className = "text-btn danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => {
      if (confirm(`Delete "${task.title}" for good?`)) deleteDoc(doc(db, "tasks", task.id));
    };
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(main);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

// ---------- log tab ----------
function renderLog(rows) {
  const list = $("list-log");
  list.innerHTML = "";
  $("log-empty").classList.toggle("hidden", rows.length > 0);
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.className = "log-row";
    const when = r.doneAt ? fmtRelative(r.doneAt.toDate()) : "";
    li.innerHTML = `<strong>${escapeHtml(r.doneByName || "Someone")}</strong> did ${escapeHtml(r.taskTitle)} &middot; ${when}`;
    list.appendChild(li);
  });
}

// ---------- task modal ----------
on("btn-add-task", "click", () => openAddTaskModal());
on("btn-cancel-task", "click", () => closeTaskModal());
on("btn-save-task", "click", () => saveTask());
on("btn-delete-task", "click", () => deleteTask());
on("input-task-freq", "change", updateFreqRows);

function updateFreqRows() {
  const type = $("input-task-freq").value;
  $("row-interval-days").classList.toggle("hidden", type !== "custom-days");
  $("row-weekday").classList.toggle("hidden", type !== "custom-weeks");
  $("wrap-interval-weeks").classList.toggle("hidden", type !== "custom-weeks");
  $("row-monthday").classList.toggle("hidden", type !== "monthly");
}

function openAddTaskModal() {
  editingTaskId = null;
  $("task-modal-title").textContent = "Add task";
  $("input-task-title").value = "";
  $("input-task-freq").value = "daily";
  $("input-interval-n").value = 2;
  $("input-interval-weeks").value = 2;
  $("input-weekday").value = String(new Date().getDay());
  $("input-monthday").value = 1;
  $("input-task-date").value = localDateStr(new Date());
  $("input-task-time").value = "";
  $("input-task-assignee").value = "";
  $("task-modal-error").textContent = "";
  $("btn-delete-task").classList.add("hidden");
  updateFreqRows();
  $("task-modal-backdrop").classList.remove("hidden");
}

function openEditTaskModal(task) {
  editingTaskId = task.id;
  $("task-modal-title").textContent = "Edit task";
  $("input-task-title").value = task.title;
  $("input-task-freq").value = task.freq.type;
  $("input-interval-n").value = task.freq.intervalDays || 2;
  $("input-interval-weeks").value = task.freq.intervalWeeks || 2;
  $("input-weekday").value = String(task.freq.weekday ?? new Date().getDay());
  $("input-monthday").value = task.freq.monthDay || 1;
  const d = task.dueAt.toDate();
  $("input-task-date").value = localDateStr(d);
  $("input-task-time").value = task.hasTime
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : "";
  $("input-task-assignee").value = task.assignedTo || "";
  $("task-modal-error").textContent = "";
  $("btn-delete-task").classList.remove("hidden");
  updateFreqRows();
  $("task-modal-backdrop").classList.remove("hidden");
}

function closeTaskModal() {
  $("task-modal-backdrop").classList.add("hidden");
}

async function saveTask() {
  const title = $("input-task-title").value.trim();
  const err = $("task-modal-error");
  err.textContent = "";
  if (!title) { err.textContent = "Give the task a name."; return; }

  const type = $("input-task-freq").value;
  let freq = { type };
  if (type === "custom-days") freq.intervalDays = Math.max(1, parseInt($("input-interval-n").value, 10) || 1);
  if (type === "custom-weeks") {
    freq.intervalWeeks = Math.max(1, parseInt($("input-interval-weeks").value, 10) || 1);
    freq.weekday = parseInt($("input-weekday").value, 10);
  }
  if (type === "monthly") freq.monthDay = Math.min(28, Math.max(1, parseInt($("input-monthday").value, 10) || 1));

  const dateStr = $("input-task-date").value;
  if (!dateStr) { err.textContent = "Pick a due date."; return; }
  const timeStr = $("input-task-time").value;
  const hasTime = !!timeStr;
  const dueDate = hasTime ? new Date(`${dateStr}T${timeStr}`) : new Date(`${dateStr}T00:00`);
  const assignedTo = $("input-task-assignee").value || null;

  $("btn-save-task").disabled = true;
  try {
    if (editingTaskId) {
      await updateDoc(doc(db, "tasks", editingTaskId), {
        title, freq, dueAt: Timestamp.fromDate(dueDate), hasTime, assignedTo,
      });
    } else {
      await addDoc(collection(db, "tasks"), {
        title, freq, dueAt: Timestamp.fromDate(dueDate), hasTime, assignedTo,
        done: false, doneBy: null, doneAt: null,
        createdBy: currentUser.uid, createdAt: serverTimestamp(),
      });
    }
    closeTaskModal();
    showToast("Task saved");
  } catch (e) {
    err.textContent = "Couldn't save right now — check your connection and try again.";
  } finally {
    $("btn-save-task").disabled = false;
  }
}

async function deleteTask() {
  if (!editingTaskId) return;
  if (!confirm("Delete this task for good?")) return;
  await deleteDoc(doc(db, "tasks", editingTaskId));
  closeTaskModal();
  showToast("Task deleted");
}

// ---------- connection status ----------
function updateSyncDot() {
  $("sync-dot").classList.toggle("offline", !navigator.onLine);
}
window.addEventListener("online", updateSyncDot);
window.addEventListener("offline", updateSyncDot);
updateSyncDot();
