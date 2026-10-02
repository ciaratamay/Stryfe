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

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
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
let selectedNewColor = null;
let rolloverTimer = null;
let activeTab = "home";

const PALETTE = [
  "#C0613F", "#1F8A66", "#7B4FA0", "#B8364C",
  "#C9970C", "#0E7C86", "#4C6E8A", "#555A64",
];

function fallbackColorForUid(uid) {
  const idx = Math.max(0, sortedProfileUids.indexOf(uid));
  return PALETTE[idx % PALETTE.length];
}

function colorForUid(uid) {
  return profilesCache[uid]?.color || fallbackColorForUid(uid);
}

function initialForUid(uid) {
  const name = profilesCache[uid]?.name || "?";
  return name.trim().charAt(0).toUpperCase();
}

function buildAvatar(uid, opts = {}) {
  const span = document.createElement("span");
  span.className = `avatar${opts.small ? " small" : ""}${uid ? "" : " unassigned"}`;
  if (uid && profilesCache[uid]) {
    span.style.background = colorForUid(uid);
    span.textContent = initialForUid(uid);
  } else {
    span.textContent = "–";
  }
  return span;
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

function showAuthStep(step) {
  $("auth-step-pick").classList.toggle("hidden", step !== "pick");
  $("auth-step-password").classList.toggle("hidden", step !== "password");
  $("auth-step-create").classList.toggle("hidden", step !== "create");
}

// ---------- auth screen wiring ----------
function renderColorSwatches() {
  const row = $("color-swatch-row");
  row.innerHTML = "";
  const usedColors = new Set(Object.values(profilesCache).map((p) => p.color).filter(Boolean));
  selectedNewColor = PALETTE.find((c) => !usedColors.has(c)) || PALETTE[0];
  PALETTE.forEach((color) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `swatch${color === selectedNewColor ? " selected" : ""}`;
    btn.style.background = color;
    btn.onclick = () => {
      selectedNewColor = color;
      row.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
      btn.classList.add("selected");
    };
    row.appendChild(btn);
  });
}

on("btn-show-add-person", "click", async () => {
  $("input-new-name").value = "";
  $("input-new-password").value = "";
  $("input-new-hint").value = "";
  $("input-new-email").value = "";
  $("create-error").textContent = "";
  await refreshProfilesCache();
  renderColorSwatches();
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
      color: selectedNewColor,
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
    populateFilterSelect($("filter-due"));
    populateFilterSelect($("filter-upcoming"));
    populateFilterSelect($("filter-done"));
    $("home-signed-out").classList.add("hidden");
    $("home-signed-in").classList.remove("hidden");
    setTabsLocked(false);
    subscribeTasks();
    subscribeLog();
    startRollover();
    switchTab("due");
  } else {
    teardown();
    $("home-signed-out").classList.remove("hidden");
    $("home-signed-in").classList.add("hidden");
    showAuthStep("pick");
    renderProfilePicker();
    setTabsLocked(true);
    switchTab("home");
  }
});

function teardown() {
  if (unsubTasks) unsubTasks();
  if (unsubLog) unsubLog();
  if (rolloverTimer) clearInterval(rolloverTimer);
  tasksById = {};
  currentUser = null;
}

// ---------- tabs ----------
function setTabsLocked(locked) {
  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    if (btn.dataset.tab === "home") return;
    btn.disabled = locked;
  });
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === `pane-${tab}`));
  $("btn-add-task").classList.toggle("hidden", !currentUser || tab === "home" || tab === "log");
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

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

function populateFilterSelect(sel) {
  const prev = sel.value;
  sel.innerHTML = '<option value="mine">Mine</option><option value="anyone">Anyone</option>';
  sortedProfileUids.forEach((uid) => {
    if (uid === currentUser.uid) return;
    const opt = document.createElement("option");
    opt.value = uid;
    opt.textContent = profilesCache[uid].name;
    sel.appendChild(opt);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
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
    renderAll();
  }, () => showToast("Having trouble syncing right now."));
}

function subscribeLog() {
  const q = query(collection(db, "log"), orderBy("doneAt", "desc"));
  unsubLog = onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push(d.data()));
    renderLogList(rows);
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
  rolloverTimer = setInterval(() => { rolloverIfNeeded(); renderAll(); }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { rolloverIfNeeded(); renderAll(); }
  });
}

function renderAll() {
  if (!currentUser) return;
  renderDue();
  renderUpcoming();
  renderDoneList();
  renderAllTasks();
}

// matches an assignment-style filter (Due/Upcoming): "mine" counts unassigned too
function matchesAssignFilter(value, assignedTo) {
  if (value === "anyone") return true;
  if (value === "mine") return !assignedTo || assignedTo === currentUser.uid;
  return assignedTo === value;
}

// matches a "done by" filter (Done tab): no unassigned concept
function matchesDoneFilter(value, doneBy) {
  if (value === "anyone") return true;
  if (value === "mine") return doneBy === currentUser.uid;
  return doneBy === value;
}

function renderDue() {
  const now = new Date();
  const filterVal = $("filter-due").value;
  let due = Object.values(tasksById).filter((t) => !t.done && isDue(t, now));
  due = due.filter((t) => matchesAssignFilter(filterVal, t.assignedTo));
  due.sort((a, b) => a.dueAt.toDate() - b.dueAt.toDate());

  const list = $("list-due");
  list.innerHTML = "";
  $("due-empty").classList.toggle("hidden", due.length > 0);
  due.forEach((t) => list.appendChild(renderOpenRow(t, "due")));
}

function renderUpcoming() {
  const now = new Date();
  const filterVal = $("filter-upcoming").value;
  let upcoming = Object.values(tasksById).filter((t) => !t.done && !isDue(t, now));
  upcoming = upcoming.filter((t) => matchesAssignFilter(filterVal, t.assignedTo));
  upcoming.sort((a, b) => a.dueAt.toDate() - b.dueAt.toDate());

  const list = $("list-upcoming");
  list.innerHTML = "";
  $("upcoming-empty").classList.toggle("hidden", upcoming.length > 0);
  upcoming.forEach((t) => list.appendChild(renderOpenRow(t, "upcoming")));
}

function renderDoneList() {
  const filterVal = $("filter-done").value;
  let done = Object.values(tasksById).filter((t) => t.done);
  done = done.filter((t) => matchesDoneFilter(filterVal, t.doneBy));
  done.sort((a, b) => (b.doneAt?.toDate() ?? 0) - (a.doneAt?.toDate() ?? 0));

  const list = $("list-done");
  list.innerHTML = "";
  $("done-empty").classList.toggle("hidden", done.length > 0);
  done.forEach((t) => list.appendChild(renderDoneRow(t)));
}

on("filter-due", "change", renderDue);
on("filter-upcoming", "change", renderUpcoming);
on("filter-done", "change", renderDoneList);
on("alltasks-search", "input", renderAllTasks);
on("alltasks-sort", "change", renderAllTasks);

function renderAllTasks() {
  if (!currentUser) return;
  const now = new Date();
  const searchVal = $("alltasks-search").value.trim().toLowerCase();
  const sortVal = $("alltasks-sort").value;

  let all = Object.values(tasksById);
  if (searchVal) all = all.filter((t) => t.title.toLowerCase().includes(searchVal));

  const lastDoneMs = (t) => t.lastDoneAt?.toDate()?.getTime() ?? -Infinity;
  if (sortVal === "alpha") all.sort((a, b) => a.title.localeCompare(b.title));
  else if (sortVal === "recent") all.sort((a, b) => lastDoneMs(b) - lastDoneMs(a));
  else if (sortVal === "stale") all.sort((a, b) => lastDoneMs(a) - lastDoneMs(b));

  const list = $("list-alltasks");
  list.innerHTML = "";
  $("alltasks-empty").classList.toggle("hidden", all.length > 0);
  all.forEach((t) => list.appendChild(renderAllTasksRow(t, now)));
}

function renderAllTasksRow(task, now) {
  const li = document.createElement("li");
  li.className = "task-row";

  const avatar = buildAvatar(task.assignedTo);

  const main = document.createElement("div");
  main.className = "task-main";
  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.title;

  const meta = document.createElement("div");
  meta.className = "task-meta";
  const status = task.done ? "done" : (isDue(task, now) ? "due" : "upcoming");
  const badge = document.createElement("span");
  badge.className = `status-badge ${status}`;
  badge.textContent = status === "done" ? "Done" : status === "due" ? "Due" : "Upcoming";
  meta.appendChild(badge);

  const freqNote = document.createElement("span");
  freqNote.className = "freq-note";
  freqNote.style.margin = "0";
  const lastDone = task.lastDoneAt ? `last done ${fmtRelative(task.lastDoneAt.toDate())}` : "never done";
  freqNote.textContent = `${freqSummary(task.freq)} · ${lastDone}`;
  meta.appendChild(freqNote);

  const editBtn = document.createElement("button");
  editBtn.className = "text-btn";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => openEditTaskModal(task);
  meta.appendChild(editBtn);

  main.appendChild(title);
  main.appendChild(meta);

  li.appendChild(avatar);
  li.appendChild(main);
  return li;
}

function fmtLogWhen(date) {
  let h = date.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  const mins = String(date.getMinutes()).padStart(2, "0");
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  const month = date.toLocaleDateString(undefined, { month: "long" });
  return `${h}.${mins}${ampm}, ${weekday} ${month} ${date.getDate()}`;
}

function renderLogList(rows) {
  const list = $("list-log");
  list.innerHTML = "";
  $("log-empty").classList.toggle("hidden", rows.length > 0);
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.className = "task-row log-row";
    const avatar = buildAvatar(r.doneBy, { small: true });

    const main = document.createElement("div");
    main.className = "task-main";
    const text = document.createElement("div");
    text.className = "log-text";
    text.innerHTML = `<strong>${escapeHtml(r.doneByName || "Someone")}</strong> completed ${escapeHtml(r.taskTitle)}`;
    const when = document.createElement("span");
    when.className = "log-when";
    when.textContent = r.doneAt ? fmtLogWhen(r.doneAt.toDate()) : "";
    main.appendChild(text);
    main.appendChild(when);

    li.appendChild(avatar);
    li.appendChild(main);
    list.appendChild(li);
  });
}

function renderOpenRow(task, kind) {
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
  meta.appendChild(buildAvatar(task.assignedTo, { small: true }));
  meta.appendChild(buildAssigneeMiniSelect(task));

  const editBtn = document.createElement("button");
  editBtn.className = "text-btn";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => openEditTaskModal(task);
  meta.appendChild(editBtn);

  const freqNote = document.createElement("span");
  freqNote.className = "freq-note";
  const verb = kind === "due" ? "due" : "next";
  freqNote.textContent = `${freqSummary(task.freq)} · ${verb} ${fmtDue(task.dueAt.toDate(), task.hasTime)}`;

  main.appendChild(title);
  main.appendChild(meta);
  main.appendChild(freqNote);

  li.appendChild(check);
  li.appendChild(main);
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
  meta.appendChild(buildAvatar(task.doneBy, { small: true }));
  const label = document.createElement("span");
  label.className = "freq-note";
  label.style.margin = "0";
  label.textContent = "Done by";
  meta.appendChild(label);
  const doneBySel = buildDoneBySelect(task.doneBy);
  doneBySel.onchange = (e) => updateDoc(doc(db, "tasks", task.id), { doneBy: e.target.value });
  meta.appendChild(doneBySel);
  const when = document.createElement("span");
  when.className = "freq-note";
  when.style.margin = "0";
  when.textContent = task.doneAt ? fmtRelative(task.doneAt.toDate()) : "";
  meta.appendChild(when);

  const editBtn = document.createElement("button");
  editBtn.className = "text-btn";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => openEditTaskModal(task);
  meta.appendChild(editBtn);

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
    lastDoneAt: serverTimestamp(),
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
  const offline = !navigator.onLine;
  $("sync-dot").classList.toggle("offline", offline);
  const t = $("sync-text");
  if (t) t.textContent = offline ? "Offline — changes will sync later" : "Synced";
}
window.addEventListener("online", updateSyncDot);
window.addEventListener("offline", updateSyncDot);
updateSyncDot();
