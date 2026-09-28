import { firebaseConfig, FUNCTIONS_REGION, PROFILES } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, query, orderBy, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { Performer } from "./player.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const functions = getFunctions(app, FUNCTIONS_REGION);
const makeTrackFn = httpsCallable(functions, "makeTrack", { timeout: 180000 });

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const SUBJECTS = {
  "Maths": "#FF4FA3", "English": "#8F74FF", "Biology": "#3DDC97", "Chemistry": "#2EC4E6", "Physics": "#5C8BFF",
  "Science": "#4FD1A5", "History": "#FF9F43", "Geography": "#2BB673", "French": "#FF6B6B", "Spanish": "#FFB400",
  "German": "#F2C94C", "Religious Studies": "#B37DFF", "Computing": "#00B8A9", "Music": "#FF7EB9", "Art": "#F76E9C",
  "Drama": "#E57CFF", "PE": "#7BD389", "Business": "#6FA8FF", "Other": "#A99BD6"
};
const colourFor = (s) => SUBJECTS[s] || SUBJECTS.Other;

const state = { user: null, profile: null, attachments: [], tracks: [], current: null, unsub: null };
const MAX_FILES = 5;

// ---------- small helpers ----------
function show(id) {
  ["splash", "signin", "home", "player"].forEach(s => { $(`#screen-${s}`).hidden = s !== id; });
  window.scrollTo(0, 0);
}
let toastTimer;
function toast(text) {
  const t = $("#toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function fmtDate(ts) {
  const d = ts?.toDate ? ts.toDate() : ts ? new Date(ts) : new Date();
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// ---------- choose who's revising ----------
// The app signs in anonymously behind the scenes; the dropdown picks whose library to open.
const profileId = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const tracksCol = () => collection(db, "profiles", profileId(state.profile), "tracks");

const sel = $("#si-profile");
sel.innerHTML = PROFILES.map(p => `<option>${esc(p)}</option>`).join("");

function enterApp() {
  if (!state.user || !state.profile) return;
  if (state.unsub) { state.unsub(); state.unsub = null; }
  $("#who").textContent = state.profile;
  show("home"); subscribeTracks();
}

onAuthStateChanged(auth, (user) => {
  state.user = user;
  if (!user) { signInAnonymously(auth).catch(() => { show("signin"); $("#si-msg").textContent = "Couldn't connect. Check the internet and reload."; }); return; }
  const saved = lsGet("er-profile", "");
  if (PROFILES.includes(saved)) { state.profile = saved; enterApp(); }
  else show("signin");
});

$("#signin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.profile = sel.value; lsSet("er-profile", state.profile);
  if (state.user) enterApp();
  else $("#si-msg").textContent = "Still connecting. Try again in a second.";
});
$("#signout").addEventListener("click", () => {
  performer.stop(true);
  if (state.unsub) { state.unsub(); state.unsub = null; }
  state.profile = null; lsSet("er-profile", ""); state.tracks = [];
  if (PROFILES.length === 1) { sel.value = PROFILES[0]; }
  show("signin");
});

// ---------- capture ----------
const subjSel = $("#subject");
Object.keys(SUBJECTS).forEach(s => subjSel.insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`));
$("#level").value = lsGet("er-level", "KS3");
const savedStyle = lsGet("er-style", "rap");
const styleInput = $(`input[name=style][value="${savedStyle}"]`); if (styleInput) styleInput.checked = true;

$("#btn-camera").addEventListener("click", () => $("#in-camera").click());
$("#btn-upload").addEventListener("click", () => $("#in-file").click());
$("#btn-type").addEventListener("click", (e) => {
  const ta = $("#notes"); ta.hidden = !ta.hidden;
  e.currentTarget.setAttribute("aria-pressed", String(!ta.hidden));
  if (!ta.hidden) ta.focus();
});
$("#in-camera").addEventListener("change", (e) => { handleFiles(e.target.files); e.target.value = ""; });
$("#in-file").addEventListener("change", (e) => { handleFiles(e.target.files); e.target.value = ""; });

function readAs(file, how) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    how === "buffer" ? r.readAsArrayBuffer(file) : how === "text" ? r.readAsText(file) : r.readAsDataURL(file);
  });
}

async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 1800, scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.85);
    return { data: dataUrl.split(",")[1], preview: dataUrl };
  } finally { URL.revokeObjectURL(url); }
}

let mammothLoading;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve();
  mammothLoading ??= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";
    s.onload = res; s.onerror = () => rej(new Error("Couldn't load the Word reader"));
    document.head.appendChild(s);
  });
  return mammothLoading;
}

async function handleFiles(fileList) {
  for (const file of fileList) {
    if (state.attachments.length >= MAX_FILES) { toast(`You can add up to ${MAX_FILES} files per track`); break; }
    const name = file.name || "Photo";
    const lower = name.toLowerCase();
    try {
      if (file.type.startsWith("image/") || /\.(heic|heif)$/.test(lower)) {
        const { data, preview } = await compressImage(file);
        state.attachments.push({ kind: "image", name, mediaType: "image/jpeg", data, preview });
      } else if (file.type === "application/pdf" || lower.endsWith(".pdf")) {
        if (file.size > 6 * 1024 * 1024) { toast(`${name} is over 6 MB. Try a shorter PDF or take photos of the pages.`); continue; }
        const data = (await readAs(file, "dataurl")).split(",")[1];
        state.attachments.push({ kind: "pdf", name, mediaType: "application/pdf", data });
      } else if (lower.endsWith(".docx")) {
        await loadMammoth();
        const { value } = await window.mammoth.extractRawText({ arrayBuffer: await readAs(file, "buffer") });
        state.attachments.push({ kind: "text", name, text: value });
      } else if (lower.endsWith(".txt") || lower.endsWith(".md") || file.type.startsWith("text/")) {
        state.attachments.push({ kind: "text", name, text: await readAs(file, "text") });
      } else {
        toast(`${name} isn't a supported file. Use a photo, PDF, Word (.docx) or text file.`);
      }
    } catch {
      toast(`Couldn't read ${name}. Try taking a photo of it instead.`);
    }
  }
  renderAttachments();
}

function renderAttachments() {
  const box = $("#attachments");
  box.innerHTML = state.attachments.map((a, i) => `
    <div class="chip">
      ${a.kind === "image" ? `<img src="${a.preview}" alt="">` : `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>`}
      <span class="name">${esc(a.name)}</span>
      <button type="button" data-remove="${i}" aria-label="Remove ${esc(a.name)}">×</button>
    </div>`).join("");
}
$("#attachments").addEventListener("click", (e) => {
  const b = e.target.closest("[data-remove]"); if (!b) return;
  state.attachments.splice(Number(b.dataset.remove), 1); renderAttachments();
});

// ---------- make a track ----------
const WORKING = ["Reading your notes", "Picking out the key facts", "Cooking up the bars", "Writing the hook", "Dropping the beat", "Checking the facts", "Nearly there"];

$("#make").addEventListener("click", async () => {
  const msg = $("#make-msg"); msg.textContent = "";
  const typed = $("#notes").value.trim();
  const texts = state.attachments.filter(a => a.kind === "text").map(a => `From ${a.name}:\n${a.text}`);
  const text = [typed, ...texts].filter(Boolean).join("\n\n").slice(0, 40000);
  const files = state.attachments.filter(a => a.kind !== "text").map(a => ({ type: a.kind, mediaType: a.mediaType, data: a.data }));
  if (!text && !files.length) { msg.textContent = "Add a photo, a file or some notes first."; return; }

  const style = $("input[name=style]:checked").value;
  const level = $("#level").value;
  const subject = $("#subject").value;
  lsSet("er-style", style); lsSet("er-level", level);

  const btn = $("#make"); btn.disabled = true;
  const working = $("#working"); working.hidden = false;
  let w = 0; $("#working-text").textContent = WORKING[0];
  const ticker = setInterval(() => { w = Math.min(w + 1, WORKING.length - 1); $("#working-text").textContent = WORKING[w]; }, 6000);

  try {
    const res = await makeTrackFn({ text, files, style, level, subject, profile: profileId(state.profile) });
    const track = res.data;
    const ref = doc(tracksCol());
    const record = { ...track, style, level, createdAt: serverTimestamp() };
    setDoc(ref, record).catch(() => toast("Couldn't save that track. Check your connection."));
    state.attachments = []; renderAttachments();
    $("#notes").value = "";
    openTrack({ id: ref.id, ...record, createdAt: new Date() });
  } catch (err) {
    const code = String(err.code || "").replace("functions/", "");
    msg.textContent =
      code === "resource-exhausted" ? (err.message || "That's today's limit reached. Try again tomorrow.")
      : code === "invalid-argument" || code === "failed-precondition" ? (err.message || "Those notes couldn't be turned into a track. Try a clearer photo.")
      : code === "deadline-exceeded" ? "That took too long. Try fewer pages at once."
      : code === "unauthenticated" || code === "permission-denied" ? "Couldn't connect. Reload the app and try again."
      : !navigator.onLine ? "You're offline. Connect to the internet to make a new track."
      : "Something went wrong making the track. Try again in a moment.";
  } finally {
    clearInterval(ticker); btn.disabled = false; working.hidden = true;
  }
});

// ---------- library ----------
function subscribeTracks() {
  const q = query(tracksCol(), orderBy("createdAt", "desc"));
  state.unsub = onSnapshot(q, (snap) => {
    state.tracks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLibrary();
  }, () => toast("Couldn't load your tracks"));
}

function renderLibrary() {
  const term = $("#search").value.trim().toLowerCase();
  const list = state.tracks.filter(t => !term || `${t.title} ${t.subject} ${t.topic}`.toLowerCase().includes(term));
  const n = state.tracks.length;
  $("#lib-count").textContent = n ? `${n} track${n === 1 ? "" : "s"} saved` : "";
  $("#search").hidden = n < 5;
  $("#empty").hidden = n > 0;
  $("#tapes").innerHTML = list.map(t => `
    <button class="tape" type="button" data-id="${t.id}" style="--c:${colourFor(t.subject)}">
      <span class="label">
        <span class="t">${esc(t.title)}</span>
        <span class="m">${esc(t.subject || "Other")} · ${esc(t.topic || "")}</span>
        <span class="m">${fmtDate(t.createdAt)}</span>
      </span>
      <span class="reels" aria-hidden="true"><i></i><i></i></span>
    </button>`).join("");
}
$("#search").addEventListener("input", renderLibrary);
$("#tapes").addEventListener("click", (e) => {
  const b = e.target.closest(".tape"); if (!b) return;
  const t = state.tracks.find(x => x.id === b.dataset.id); if (t) openTrack(t);
});

// ---------- player ----------
const performer = new Performer({
  onLine: (i) => {
    $$(".line.is-current").forEach(el => el.classList.remove("is-current"));
    const el = document.querySelector(`.line[data-i="${i}"]`);
    if (el) {
      el.classList.add("is-current");
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }
  },
  onStop: () => setPlaying(false),
});
performer.voiceOn = lsGet("er-voice", "1") === "1";
performer.beat.onKick = () => {
  $$(".speaker").forEach(sp => { sp.classList.add("thump"); setTimeout(() => sp.classList.remove("thump"), 110); });
};
performer.speed = Number(lsGet("er-speed", "1"));

function setPlaying(p) {
  $("#ico-play").hidden = p; $("#ico-pause").hidden = !p;
  $("#play").setAttribute("aria-label", p ? "Pause" : "Play");
  $("#tab-lyrics").classList.toggle("playing", p);
  if (!p) $$(".line.is-current").forEach(el => el.classList.remove("is-current"));
}

function openTrack(t) {
  state.current = t;
  performer.stop(true); setPlaying(false);
  $("#p-title").textContent = t.title;
  $("#p-meta").textContent = [t.subject, t.topic, styleName(t.style)].filter(Boolean).join(" · ");

  // Lyrics
  const lines = []; let html = "";
  (t.sections || []).forEach((sec, si) => {
    html += `<div class="section"><p class="section-name">${esc(sectionName(sec.type))}</p>`;
    (sec.lines || []).forEach(text => {
      const i = lines.length;
      lines.push({ text, type: sec.type, sectionIndex: si });
      html += `<p class="line" data-i="${i}"><span>${esc(text)}</span></p>`;
    });
    html += `</div>`;
  });
  $("#tab-lyrics").innerHTML = html;
  performer.load(lines, t.style);

  // Key facts
  $("#facts").innerHTML = (t.keyFacts || []).map(f => `<li>${esc(f)}</li>`).join("");

  renderQuiz(t);
  selectTab("lyrics");
  show("player");
}

const styleName = (s) => ({ rap: "Rap", pop: "Pop", chant: "Chant", chill: "Chill" }[s] || "");
const sectionName = (s) => ({ intro: "Intro", verse: "Verse", chorus: "Chorus", bridge: "Bridge", outro: "Outro" }[s] || "Verse");

function renderQuiz(t) {
  const qs = (t.quiz || []).filter(q => Array.isArray(q.options) && q.options.length);
  const picks = new Map(); // question index -> option picked
  const box = $("#tab-quiz");
  const draw = () => {
    const right = [...picks].filter(([qi, oi]) => oi === qs[qi].answer).length;
    box.innerHTML = `<p class="score">${picks.size ? `${right} out of ${picks.size} right` : `${qs.length} questions`}</p>` +
      qs.map((q, qi) => {
        const done = picks.has(qi), picked = picks.get(qi);
        return `<div class="q"><h3>${qi + 1}. ${esc(q.question)}</h3>` +
          q.options.map((o, oi) => {
            let cls = "opt";
            if (done) { if (oi === q.answer) cls += " right"; else if (oi === picked) cls += " wrong"; }
            return `<button type="button" class="${cls}" data-q="${qi}" data-o="${oi}" ${done ? "disabled" : ""}>${esc(o)}</button>`;
          }).join("") +
          (done && q.explanation ? `<p class="why">${esc(q.explanation)}</p>` : "") + `</div>`;
      }).join("") +
      (picks.size ? `<button type="button" class="link-btn" id="quiz-reset">Start the quiz again</button>` : "");
  };
  box.onclick = (e) => {
    if (e.target.id === "quiz-reset") { picks.clear(); draw(); return; }
    const b = e.target.closest(".opt"); if (!b || b.disabled) return;
    picks.set(Number(b.dataset.q), Number(b.dataset.o));
    draw();
  };
  draw();
}

function selectTab(name) {
  $$(".tabs [role=tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  ["lyrics", "facts", "quiz"].forEach(n => ($(`#tab-${n}`).hidden = n !== name));
}
$(".tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) selectTab(b.dataset.tab); });

$("#play").addEventListener("click", () => {
  if (performer.playing) { performer.stop(true); setPlaying(false); return; }
  selectTab("lyrics");
  const from = performer.index >= 0 && performer.index < performer.lines.length - 1 ? performer.index : 0;
  performer.play(from); setPlaying(true);
});
$("#tab-lyrics").addEventListener("click", (e) => {
  const l = e.target.closest(".line"); if (!l) return;
  performer.play(Number(l.dataset.i)); setPlaying(true);
});

const speed = $("#speed");
speed.value = performer.speed;
speed.addEventListener("change", () => {
  performer.speed = Number(speed.value); lsSet("er-speed", speed.value);
  if (performer.playing) { performer.play(Math.max(0, performer.index)); setPlaying(true); }
});

function bindToggle(id, get, set) {
  const b = $(id); b.setAttribute("aria-pressed", String(get()));
  b.addEventListener("click", () => {
    set(!get()); b.setAttribute("aria-pressed", String(get()));
    if (performer.playing) { performer.play(Math.max(0, performer.index)); setPlaying(true); }
  });
}
bindToggle("#t-voice", () => performer.voiceOn, (v) => { performer.voiceOn = v; lsSet("er-voice", v ? "1" : "0"); });
bindToggle("#t-beat", () => !performer.beat.muted, (v) => performer.beat.setMuted(!v));
bindToggle("#t-chorus", () => performer.loopChorus, (v) => { performer.loopChorus = v; });

$("#back").addEventListener("click", () => { performer.stop(true); setPlaying(false); show("home"); });
document.addEventListener("visibilitychange", () => { if (document.hidden && performer.playing) { performer.stop(true); setPlaying(false); } });

$("#delete").addEventListener("click", async () => {
  const t = state.current; if (!t) return;
  if (!confirm(`Delete "${t.title}"? This can't be undone.`)) return;
  performer.stop(true);
  try { await deleteDoc(doc(tracksCol(), t.id)); toast("Track deleted"); show("home"); }
  catch { toast("Couldn't delete that track. Try again."); }
});
