import { firebaseConfig, FUNCTIONS_REGION, PROFILES } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, addDoc, updateDoc, deleteDoc, query, orderBy, onSnapshot, serverTimestamp, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { Performer, BEATS, STYLE_BEAT, DELIVERY, englishVoices } from "./player.js";
import { PRESETS } from "./presets.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const functions = getFunctions(app, FUNCTIONS_REGION);
const makeTrackFn = httpsCallable(functions, "makeTrack", { timeout: 180000 });
const makeSongFn = httpsCallable(functions, "makeSong", { timeout: 560000 });

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const SUBJECTS = {
  "Maths": "#FF4FA3", "English": "#8F74FF", "Biology": "#3DDC97", "Chemistry": "#2EC4E6", "Physics": "#5C8BFF",
  "Science": "#4FD1A5", "History": "#FF9F43", "Geography": "#2BB673", "French": "#FF6B6B", "Spanish": "#FFB400",
  "German": "#F2C94C", "Religious Studies": "#B37DFF", "Computing": "#00B8A9", "Music": "#FF7EB9", "Art": "#F76E9C",
  "Drama": "#E57CFF", "PE": "#7BD389", "Business": "#6FA8FF", "Other": "#A99BD6"
};
const colourFor = (s) => SUBJECTS[s] || SUBJECTS.Other;

const state = {
  user: null, profile: null, attachments: [], tracks: [], playlists: [], favs: new Set(),
  songs: {}, mode: "synth", current: null, queue: null, libTab: "mine", openPlaylistId: null, unsubs: [],
};
const MAX_FILES = 5;

// ---------- small helpers ----------
const SCREENS = ["splash", "signin", "home", "player", "playlist"];
function show(id) { SCREENS.forEach(s => { $(`#screen-${s}`).hidden = s !== id; }); window.scrollTo(0, 0); }
let toastTimer;
function toast(text) {
  const t = $("#toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3000);
}
function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function fmtDate(ts) {
  const d = ts?.toDate ? ts.toDate() : ts ? new Date(ts) : new Date();
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const HEART = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2.1 0 3.6 1.2 4.4 2.5.8-1.3 2.3-2.5 4.4-2.5C19 5 21 8.6 19.6 11.8 17.5 16.4 12 21 12 21z"/></svg>`;

// ---------- data paths ----------
const profileId = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const base = () => ["profiles", profileId(state.profile)];
const tracksCol = () => collection(db, ...base(), "tracks");
const playlistsCol = () => collection(db, ...base(), "playlists");
const favsDoc = () => doc(db, ...base(), "meta", "favourites");
const songsCol = () => collection(db, ...base(), "songs");

const allTracks = () => [...state.tracks, ...PRESETS];
const trackById = (id) => allTracks().find(t => t.id === id);

// ---------- choose who's on the mic ----------
const sel = $("#si-profile");
sel.innerHTML = PROFILES.map(p => `<option>${esc(p)}</option>`).join("");

function stopListening() { state.unsubs.forEach(u => u()); state.unsubs = []; }

function enterApp() {
  if (!state.user || !state.profile) return;
  stopListening();
  $("#who").textContent = state.profile;
  show("home");
  state.unsubs.push(onSnapshot(query(tracksCol(), orderBy("createdAt", "desc")), (snap) => {
    state.tracks = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderLibrary();
  }, () => toast("Couldn't load your tracks")));
  state.unsubs.push(onSnapshot(query(playlistsCol(), orderBy("createdAt", "desc")), (snap) => {
    state.playlists = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderLibrary();
    if (!$("#screen-playlist").hidden) renderPlaylistScreen();
  }, () => {}));
  state.unsubs.push(onSnapshot(songsCol(), (snap) => {
    state.songs = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
    renderLibrary(); if (state.current && !$("#screen-player").hidden) syncSongUI();
  }, () => {}));
  state.unsubs.push(onSnapshot(favsDoc(), (snap) => {
    state.favs = new Set(snap.exists() ? snap.data().ids || [] : []); renderLibrary(); syncFavButton();
  }, () => {}));
  renderLibrary();
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
  if (state.user) enterApp(); else $("#si-msg").textContent = "Still connecting. Try again in a second.";
});
$("#signout").addEventListener("click", () => {
  performer.stop(true); songAudio.pause(); stopListening();
  state.profile = null; lsSet("er-profile", ""); state.tracks = []; state.playlists = []; state.favs = new Set();
  show("signin");
});

// ---------- capture ----------
const subjSel = $("#subject");
Object.keys(SUBJECTS).forEach(s => subjSel.insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`));
$("#level").value = lsGet("er-level", "GCSE");
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
    state.queue = null;
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
function tapeHTML(t) {
  const fav = state.favs.has(t.id);
  return `<div class="tape-wrap">
    <button class="tape" type="button" data-id="${esc(t.id)}" style="--c:${colourFor(t.subject)}">
      <span class="label">
        <span class="t">${esc(t.title)}</span>
        <span class="m">${esc(t.subject || "Other")} · ${esc(t.topic || "")}</span>
        ${t.preset ? `<span class="badge">GCSE pack</span>` : `<span class="m">${fmtDate(t.createdAt)}</span>`}${state.songs[t.id] ? `<span class="song-badge">♪ Song</span>` : ""}
      </span>
      <span class="reels" aria-hidden="true"><i></i><i></i></span>
    </button>
    <button class="fav" type="button" data-fav="${esc(t.id)}" aria-pressed="${fav}" aria-label="${fav ? "Remove from" : "Add to"} favourites">${HEART}</button>
  </div>`;
}

function renderLibrary() {
  if (!state.profile) return;
  const tab = state.libTab;
  $$("#lib-tabs [data-lib]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.lib === tab)));
  const term = $("#search").value.trim().toLowerCase();
  const match = (t) => !term || `${t.title} ${t.subject} ${t.topic}`.toLowerCase().includes(term);
  const isPl = tab === "playlists";
  $("#pl-view").hidden = !isPl; $("#tapes").hidden = isPl;

  let list = [], empty = "", count = "";
  if (tab === "mine") { list = state.tracks; count = list.length ? `${list.length} track${list.length === 1 ? "" : "s"} you've made` : ""; empty = "No tracks yet. Snap a revision sheet and make your first one – or try the GCSE pack."; }
  if (tab === "gcse") { list = PRESETS; count = "Ready-made tracks for GCSE English and Maths"; }
  if (tab === "favs") { list = allTracks().filter(t => state.favs.has(t.id)); count = list.length ? `${list.length} favourite${list.length === 1 ? "" : "s"}` : ""; empty = "Tap the heart on any track to add it here."; }
  if (isPl) { count = state.playlists.length ? `${state.playlists.length} playlist${state.playlists.length === 1 ? "" : "s"}` : ""; empty = state.playlists.length ? "" : "Make a playlist for each exam, then add tracks from the player."; }

  $("#search").hidden = isPl || list.length < 6;
  const shown = list.filter(match);
  $("#lib-count").textContent = count;
  $("#tapes").innerHTML = shown.map(tapeHTML).join("");
  $("#pl-grid").innerHTML = state.playlists.map(p => {
    const n = (p.trackIds || []).filter(trackById).length;
    return `<button class="pl-card" type="button" data-pl="${esc(p.id)}"><span><span class="n">${esc(p.name)}</span><br><span class="c">${n} track${n === 1 ? "" : "s"}</span></span>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>`;
  }).join("");
  const isEmpty = isPl ? !state.playlists.length : !shown.length;
  $("#empty").hidden = !isEmpty || !empty; $("#empty").textContent = term && !isPl ? "No tracks match that search." : empty;
}

$("#lib-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-lib]"); if (!b) return;
  state.libTab = b.dataset.lib; $("#search").value = ""; renderLibrary();
});
$("#search").addEventListener("input", renderLibrary);
$("#tapes").addEventListener("click", (e) => {
  const f = e.target.closest("[data-fav]"); if (f) { toggleFav(f.dataset.fav); return; }
  const b = e.target.closest(".tape"); if (!b) return;
  const t = trackById(b.dataset.id); if (t) { state.queue = null; openTrack(t); }
});

// ---------- favourites ----------
async function toggleFav(id) {
  const on = !state.favs.has(id);
  on ? state.favs.add(id) : state.favs.delete(id);
  renderLibrary(); syncFavButton();
  try { await setDoc(favsDoc(), { ids: on ? arrayUnion(id) : arrayRemove(id) }, { merge: true }); }
  catch { toast("Couldn't save that favourite"); }
}
function syncFavButton() {
  const t = state.current; if (!t) return;
  const on = state.favs.has(t.id);
  $("#p-fav").setAttribute("aria-pressed", String(on));
  $("#p-fav span").textContent = on ? "Favourited" : "Favourite";
}
$("#p-fav").addEventListener("click", () => state.current && toggleFav(state.current.id));

// ---------- playlists ----------
async function createPlaylist(name, firstTrackId) {
  name = name.trim(); if (!name) { toast("Give the playlist a name"); return null; }
  try {
    const ref = await addDoc(playlistsCol(), { name: name.slice(0, 40), trackIds: firstTrackId ? [firstTrackId] : [], createdAt: serverTimestamp() });
    toast(`Playlist "${name}" created`); return ref.id;
  } catch { toast("Couldn't create that playlist"); return null; }
}
$("#new-pl-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const inp = $("#new-pl-name");
  if (await createPlaylist(inp.value)) inp.value = "";
});
$("#pl-grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pl]"); if (!b) return;
  state.openPlaylistId = b.dataset.pl; renderPlaylistScreen(); show("playlist");
});

function currentPlaylist() { return state.playlists.find(p => p.id === state.openPlaylistId); }
function renderPlaylistScreen() {
  const p = currentPlaylist();
  if (!p) { show("home"); return; }
  const tracks = (p.trackIds || []).map(trackById).filter(Boolean);
  $("#pl-title").textContent = p.name;
  $("#pl-meta").textContent = tracks.length ? `${tracks.length} track${tracks.length === 1 ? "" : "s"}` : "Empty. Open any track and tap Add to playlist.";
  $("#pl-play").disabled = !tracks.length;
  $("#pl-rows").innerHTML = tracks.map((t, i) => `<li>
    <button class="row-main" type="button" data-i="${i}"><b>${esc(t.title)}</b><span>${esc(t.subject)} · ${esc(t.topic || "")}</span></button>
    <button class="x" type="button" data-remove="${esc(t.id)}" aria-label="Remove ${esc(t.title)} from playlist">×</button></li>`).join("");
}
function playFromPlaylist(i) {
  const p = currentPlaylist(); if (!p) return;
  const ids = (p.trackIds || []).filter(trackById);
  if (!ids[i]) return;
  state.queue = { ids, index: i, name: p.name };
  openTrack(trackById(ids[i]), { autoplay: true });
}
$("#pl-play").addEventListener("click", () => playFromPlaylist(0));
$("#pl-rows").addEventListener("click", async (e) => {
  const x = e.target.closest("[data-remove]");
  if (x) { try { await updateDoc(doc(playlistsCol(), state.openPlaylistId), { trackIds: arrayRemove(x.dataset.remove) }); } catch { toast("Couldn't remove that track"); } return; }
  const r = e.target.closest(".row-main"); if (r) playFromPlaylist(Number(r.dataset.i));
});
$("#pl-back").addEventListener("click", () => { state.libTab = "playlists"; renderLibrary(); show("home"); });
$("#pl-rename").addEventListener("click", async () => {
  const p = currentPlaylist(); if (!p) return;
  const name = prompt("New name for this playlist", p.name); if (!name?.trim()) return;
  try { await updateDoc(doc(playlistsCol(), p.id), { name: name.trim().slice(0, 40) }); } catch { toast("Couldn't rename it"); }
});
$("#pl-delete").addEventListener("click", async () => {
  const p = currentPlaylist(); if (!p) return;
  if (!confirm(`Delete the playlist "${p.name}"? The tracks themselves stay in your mixtape.`)) return;
  try { await deleteDoc(doc(playlistsCol(), p.id)); state.libTab = "playlists"; renderLibrary(); show("home"); toast("Playlist deleted"); }
  catch { toast("Couldn't delete it"); }
});

// Add-to-playlist dialog
const plDlg = $("#pl-dlg");
function renderPlPick() {
  const id = state.current?.id;
  $("#pl-pick").innerHTML = state.playlists.length
    ? state.playlists.map(p => `<label><input type="checkbox" data-pl="${esc(p.id)}" ${(p.trackIds || []).includes(id) ? "checked" : ""}> ${esc(p.name)}</label>`).join("")
    : `<p class="hint">No playlists yet. Create one below.</p>`;
}
$("#p-addpl").addEventListener("click", () => { renderPlPick(); plDlg.showModal(); });
$("#pl-pick").addEventListener("change", async (e) => {
  const c = e.target.closest("[data-pl]"); if (!c || !state.current) return;
  try { await updateDoc(doc(playlistsCol(), c.dataset.pl), { trackIds: c.checked ? arrayUnion(state.current.id) : arrayRemove(state.current.id) }); }
  catch { toast("Couldn't update that playlist"); c.checked = !c.checked; }
});
$("#dlg-new-pl").addEventListener("submit", async (e) => {
  e.preventDefault(); const inp = $("#dlg-new-name");
  if (await createPlaylist(inp.value, state.current?.id)) { inp.value = ""; setTimeout(renderPlPick, 400); }
});
$("#pl-dlg-done").addEventListener("click", () => plDlg.close());


// ---------- real songs (ElevenLabs) ----------
const songAudio = new Audio();
songAudio.preload = "auto";
let songLine = -1;
const songOf = (t) => (t ? state.songs[t.id] : null);
const usingSong = () => state.mode === "song" && !!songOf(state.current);

function stopSong() { songAudio.pause(); }
function stopAll() { performer.stop(true); performer.stopReading(); stopSong(); setPlaying(false); resetReadBtn(); }

function syncSongUI() {
  const t = state.current; if (!t) return;
  const song = songOf(t);
  $("#mode-row").hidden = !song;
  if (!song && state.mode === "song") state.mode = "synth";
  $$("#mode-row [data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
  $("#p-song span").textContent = song ? "Remake the song" : "Make it a real song";
  $("#p-song").classList.toggle("hot", !song);
  $("#song-progress").hidden = !usingSong();
  $("#t-sound").hidden = usingSong();
  if (song && songAudio.dataset.track !== t.id) { songAudio.src = song.url; songAudio.dataset.track = t.id; }
  if (song) songAudio.playbackRate = settings.speed;
}

$("#mode-row").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]"); if (!b) return;
  stopAll(); state.mode = b.dataset.mode; lsSet("er-mode", state.mode); syncSongUI();
});

// The planned timeline is stretched to the song's real length, since the music model may run slightly long or short
function segs() {
  const song = songOf(state.current); if (!song) return [];
  const real = songAudio.duration * 1000, k = isFinite(real) && song.totalMs ? real / song.totalMs : 1;
  const f = k > 0.6 && k < 1.7 ? k : 1;
  return song.timeline.map(g => ({ ...g, startMs: g.startMs * f, durMs: g.durMs * f }));
}
function chorusSegment() {
  const t = state.current; if (!t || !songOf(t)) return null;
  const ci = (t.sections || []).findIndex(sec => sec.type === "chorus");
  return ci >= 0 ? segs()[ci + 1] : null;
}
function lineAtMs(ms) {
  const song = songOf(state.current); if (!song) return -1;
  const seg = segs().find(g => g.lines && ms >= g.startMs && ms < g.startMs + g.durMs);
  if (!seg) return -1;
  return seg.lineStart + Math.min(seg.lines - 1, Math.floor((ms - seg.startMs) / seg.durMs * seg.lines));
}
function msAtLine(i) {
  const song = songOf(state.current); if (!song) return 0;
  const seg = segs().find(g => g.lines && i >= g.lineStart && i < g.lineStart + g.lines);
  return seg ? seg.startMs + (i - seg.lineStart) / seg.lines * seg.durMs : 0;
}

songAudio.addEventListener("timeupdate", () => {
  if (!usingSong()) return;
  const ms = songAudio.currentTime * 1000;
  const dur = songAudio.duration || (songOf(state.current)?.totalMs || 1) / 1000;
  $("#song-progress i").style.width = `${Math.min(100, songAudio.currentTime / dur * 100)}%`;
  const seg = chorusSegment();
  if (performer.loopChorus && seg && (ms > seg.startMs + seg.durMs || ms < seg.startMs - 500)) { songAudio.currentTime = seg.startMs / 1000; return; }
  const i = lineAtMs(ms);
  if (i !== songLine) { songLine = i; if (i >= 0) performer.onLine(i); else $$(".line.is-current").forEach(el => el.classList.remove("is-current")); }
});
songAudio.addEventListener("ended", () => { if (usingSong()) handleEnd(); });
songAudio.addEventListener("error", () => { if (usingSong() && songAudio.src) toast("Couldn't load the song. Check the internet connection."); setPlaying(false); });

function playSong(fromLine = -1) {
  performer.stop(true); performer.stopReading(); resetReadBtn();
  songAudio.playbackRate = settings.speed;
  if (fromLine >= 0) songAudio.currentTime = msAtLine(fromLine) / 1000;
  else if (performer.loopChorus && chorusSegment()) songAudio.currentTime = chorusSegment().startMs / 1000;
  songLine = -1;
  songAudio.play().then(() => setPlaying(true)).catch(() => { setPlaying(false); toast("Tap play again to start the song"); });
}

// Make-a-song dialog
const songDlg = $("#song-dlg");
const STYLE_SONG_BEAT = { rap: "boombap", pop: "pop", chant: "grime", chill: "lofi" };
const SONG_WORKING = ["Booking the studio", "Laying down the beat", "Warming up the vocals", "Recording the verses", "Stacking the hook", "Mixing it down", "Nearly there – adding the final polish"];
let songBusy = false;
$("#p-song").addEventListener("click", () => {
  const t = state.current; if (!t) return;
  const song = songOf(t);
  $("#song-beat").value = song?.beat || lsGet("er-song-beat", "") || STYLE_SONG_BEAT[t.style] || "boombap";
  $("#song-voice").value = song?.voice || lsGet("er-song-voice", "female-rap");
  $("#song-h").textContent = song ? "Remake the song" : "Make it a real song";
  if (!songBusy) { $("#song-msg").textContent = ""; $("#song-working").hidden = true; }
  songDlg.showModal();
});
$("#song-cancel").addEventListener("click", () => songDlg.close());
$("#song-go").addEventListener("click", async () => {
  const t = state.current; if (!t || songBusy) return;
  const beat = $("#song-beat").value, voice = $("#song-voice").value;
  lsSet("er-song-beat", beat); lsSet("er-song-voice", voice);
  songBusy = true; $("#song-go").disabled = true; $("#song-msg").textContent = "";
  $("#song-working").hidden = false;
  let w = 0; $("#song-working-text").textContent = SONG_WORKING[0];
  const ticker = setInterval(() => { w = Math.min(w + 1, SONG_WORKING.length - 1); $("#song-working-text").textContent = SONG_WORKING[w]; }, 15000);
  const trackIdAtStart = t.id;
  try {
    const res = await makeSongFn({ profile: profileId(state.profile), trackId: t.id, sections: t.sections, beat, voice });
    state.songs[trackIdAtStart] = res.data;
    if (state.current?.id === trackIdAtStart) {
      stopAll(); state.mode = "song"; lsSet("er-mode", "song"); songAudio.dataset.track = ""; syncSongUI();
      if (songDlg.open) songDlg.close();
    }
    renderLibrary();
    toast("Your song is ready – press play!");
  } catch (err) {
    const code = String(err.code || "").replace("functions/", "");
    $("#song-msg").textContent = ["resource-exhausted", "failed-precondition", "invalid-argument", "unavailable", "internal"].includes(code) && err.message
      ? err.message : code === "deadline-exceeded" ? "The studio took too long. Try again – shorter tracks are quicker." : "Something went wrong making the song. Try again in a moment.";
    if (!songDlg.open) toast($("#song-msg").textContent);
  } finally {
    clearInterval(ticker); songBusy = false; $("#song-go").disabled = false; $("#song-working").hidden = true;
  }
});

// ---------- sound settings ----------
const settings = {
  beat: lsGet("er-beat", "auto"), voice: lsGet("er-voice", ""), delivery: lsGet("er-delivery", "mc"),
  flow: lsGet("er-flow", "1") === "1", hype: lsGet("er-hype", "1") === "1", karaoke: lsGet("er-karaoke", "0") === "1",
  speed: Number(lsGet("er-speed", "1")),
};
const beatFor = (t) => settings.beat === "auto" ? (STYLE_BEAT[t?.style] || "boombap") : settings.beat;

function applySettings() {
  performer.voiceURI = settings.voice;
  const vs = englishVoices();
  performer.hypeURI = (vs.find(v => v.voiceURI !== settings.voice && /en[-_]GB/i.test(v.lang)) || vs.find(v => v.voiceURI !== settings.voice) || {}).voiceURI || "";
  performer.delivery = settings.delivery;
  performer.flow = settings.flow; performer.hype = settings.hype; performer.voiceOn = !settings.karaoke;
  performer.speed = settings.speed;
  performer.beatId = beatFor(state.current);
}

const soundDlg = $("#sound-dlg");
function fillSound() {
  $("#set-beat").innerHTML = `<option value="auto">Match the track</option>` +
    Object.entries(BEATS).map(([id, b]) => `<option value="${id}">${esc(b.name)}</option>`).join("");
  $("#set-beat").value = settings.beat;
  const vs = englishVoices();
  $("#set-voice").innerHTML = vs.length
    ? vs.map(v => `<option value="${esc(v.voiceURI)}">${/(Google|Natural|Enhanced|Premium|Neural)/i.test(v.name) ? "★ " : ""}${esc(v.name)} (${esc(v.lang)})</option>`).join("")
    : `<option value="">Default voice</option>`;
  if (settings.voice && vs.some(v => v.voiceURI === settings.voice)) $("#set-voice").value = settings.voice;
  else if (vs[0]) { settings.voice = vs[0].voiceURI; }
  $("#set-delivery").innerHTML = Object.entries(DELIVERY).map(([id, d]) => `<option value="${id}">${esc(d.name)}</option>`).join("");
  $("#set-delivery").value = settings.delivery;
  $("#set-flow").checked = settings.flow; $("#set-hype").checked = settings.hype; $("#set-karaoke").checked = settings.karaoke;
}
if ("speechSynthesis" in window) speechSynthesis.addEventListener?.("voiceschanged", () => { if (soundDlg.open) fillSound(); applySettings(); });

function saveSound() {
  settings.beat = $("#set-beat").value; settings.voice = $("#set-voice").value; settings.delivery = $("#set-delivery").value;
  settings.flow = $("#set-flow").checked; settings.hype = $("#set-hype").checked; settings.karaoke = $("#set-karaoke").checked;
  lsSet("er-beat", settings.beat); lsSet("er-voice", settings.voice); lsSet("er-delivery", settings.delivery);
  lsSet("er-flow", settings.flow ? "1" : "0"); lsSet("er-hype", settings.hype ? "1" : "0"); lsSet("er-karaoke", settings.karaoke ? "1" : "0");
  applySettings();
}
$("#t-sound").addEventListener("click", () => { fillSound(); soundDlg.showModal(); });
soundDlg.addEventListener("change", saveSound);
$("#sound-test").addEventListener("click", () => {
  saveSound(); performer.stop(true); setPlaying(false);
  performer.stopReading();
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const d = DELIVERY[settings.delivery] || DELIVERY.mc;
  const u = new SpeechSynthesisUtterance("Yo, this is how I sound. Let's get this revision done!");
  const v = englishVoices().find(x => x.voiceURI === settings.voice); if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = d.rate; u.pitch = d.pitch; speechSynthesis.speak(u);
});
$("#sound-done").addEventListener("click", () => {
  saveSound(); soundDlg.close();
  if (performer.playing) { performer.play(Math.max(0, performer.index)); setPlaying(true); }
});

// ---------- player ----------
const performer = new Performer({
  onLine: (i) => {
    $$(".line.is-current").forEach(el => el.classList.remove("is-current"));
    const el = document.querySelector(`.line[data-i="${i}"]`);
    if (el) {
      el.classList.add("is-current");
      el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  },
  onStop: () => setPlaying(false),
  onEnd: () => handleEnd(),
});
function handleEnd() {
  setPlaying(false);
  const q = state.queue;
  if (q && q.index < q.ids.length - 1) {
    q.index++; const next = trackById(q.ids[q.index]);
    if (next) setTimeout(() => openTrack(next, { autoplay: true }), 800);
  }
}
performer.beat.onKick = () => {
  $$(".speaker").forEach(sp => { sp.classList.add("thump"); setTimeout(() => sp.classList.remove("thump"), 110); });
};
applySettings();

function setPlaying(p) {
  $("#ico-play").hidden = p; $("#ico-pause").hidden = !p;
  $("#play").setAttribute("aria-label", p ? "Pause" : "Play");
  $("#tab-lyrics").classList.toggle("playing", p);
  if (!p) $$(".line.is-current").forEach(el => el.classList.remove("is-current"));
}

const styleName = (s) => ({ rap: "Rap", pop: "Pop", chant: "Chant", chill: "Chill" }[s] || "");
const sectionName = (s) => ({ intro: "Intro", verse: "Verse", chorus: "Chorus", bridge: "Bridge", outro: "Outro" }[s] || "Verse");
const explanationOf = (t) => Array.isArray(t.explanation) ? t.explanation : t.explanation ? [t.explanation] : [];

function openTrack(t, { autoplay = false } = {}) {
  state.current = t;
  stopAll(); songLine = -1;
  state.mode = songOf(t) ? lsGet("er-mode", "song") : "synth";
  $("#p-title").textContent = t.title;
  $("#p-meta").textContent = [t.subject, t.topic, styleName(t.style)].filter(Boolean).join(" · ");
  const q = state.queue;
  const next = q && q.index < q.ids.length - 1 ? trackById(q.ids[q.index + 1]) : null;
  $("#upnext").hidden = !q;
  if (q) $("#upnext").textContent = `${q.name}: ${q.index + 1} of ${q.ids.length}${next ? ` · Up next: ${next.title}` : ""}`;
  syncFavButton();
  $("#delete").hidden = !!t.preset;

  const lines = []; let html = "";
  (t.sections || []).forEach((sec, si) => {
    html += `<div class="section"><p class="section-name">${esc(sectionName(sec.type))}</p>`;
    (sec.lines || []).forEach(text => {
      const i = lines.length; lines.push({ text, type: sec.type, sectionIndex: si });
      html += `<p class="line" data-i="${i}"><span>${esc(text)}</span></p>`;
    });
    html += `</div>`;
  });
  $("#tab-lyrics").innerHTML = html;
  applySettings();
  performer.load(lines, beatFor(t));

  const ex = explanationOf(t);
  $("#explain-body").innerHTML = ex.length ? ex.map(p => `<p class="para">${esc(p)}</p>`).join("") : "";
  $("#read-explain").hidden = !ex.length && !(t.keyFacts || []).length;
  $("#facts").innerHTML = (t.keyFacts || []).map(f => `<li>${esc(f)}</li>`).join("");

  renderQuiz(t);
  selectTab("lyrics");
  show("player");
  syncSongUI();
  if (usingSong()) songAudio.currentTime = 0;
  if (autoplay) { if (usingSong()) playSong(); else { performer.play(0); setPlaying(true); } }
}

function renderQuiz(t) {
  const qs = (t.quiz || []).filter(q => Array.isArray(q.options) && q.options.length);
  const picks = new Map();
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
    picks.set(Number(b.dataset.q), Number(b.dataset.o)); draw();
  };
  draw();
}

function selectTab(name) {
  $$(".tabs [role=tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  ["lyrics", "facts", "quiz"].forEach(n => ($(`#tab-${n}`).hidden = n !== name));
}
$(".tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) selectTab(b.dataset.tab); });

// Read the explanation out clearly
function resetReadBtn() { $("#read-explain").textContent = "Read it out clearly"; }
$("#read-explain").addEventListener("click", () => {
  if (performer.reading) { performer.stopReading(); resetReadBtn(); return; }
  const t = state.current; if (!t) return;
  stopSong(); performer.stop(true); setPlaying(false); applySettings();
  const texts = [...explanationOf(t), ...(t.keyFacts?.length ? ["Key facts.", ...t.keyFacts] : [])];
  $("#read-explain").textContent = "Stop reading";
  performer.readClearly(texts, resetReadBtn);
});

$("#play").addEventListener("click", () => {
  performer.stopReading(); resetReadBtn();
  if (usingSong()) {
    selectTab("lyrics");
    if (!songAudio.paused) { songAudio.pause(); setPlaying(false); } else playSong();
    return;
  }
  if (performer.playing) { performer.stop(true); setPlaying(false); return; }
  selectTab("lyrics"); applySettings(); performer.beatId = beatFor(state.current);
  const from = performer.index >= 0 && performer.index < performer.lines.length - 1 ? performer.index : 0;
  performer.play(from); setPlaying(true);
});
$("#tab-lyrics").addEventListener("click", (e) => {
  const l = e.target.closest(".line"); if (!l) return;
  if (usingSong()) { playSong(Number(l.dataset.i)); return; }
  performer.stopReading(); resetReadBtn(); applySettings();
  performer.play(Number(l.dataset.i)); setPlaying(true);
});

const speed = $("#speed");
speed.value = settings.speed;
speed.addEventListener("change", () => {
  settings.speed = Number(speed.value); lsSet("er-speed", speed.value); applySettings();
  songAudio.playbackRate = settings.speed;
  if (performer.playing) { performer.play(Math.max(0, performer.index)); setPlaying(true); }
});
const chorusBtn = $("#t-chorus");
chorusBtn.addEventListener("click", () => {
  performer.loopChorus = !performer.loopChorus; chorusBtn.setAttribute("aria-pressed", String(performer.loopChorus));
  if (usingSong()) { if (!songAudio.paused && performer.loopChorus && chorusSegment()) songAudio.currentTime = chorusSegment().startMs / 1000; return; }
  if (performer.playing) { performer.play(Math.max(0, performer.index)); setPlaying(true); }
});

$("#back").addEventListener("click", () => {
  stopAll();
  if (state.queue && currentPlaylist()) { renderPlaylistScreen(); show("playlist"); } else show("home");
});
document.addEventListener("visibilitychange", () => { if (document.hidden && performer.playing) { performer.stop(true); setPlaying(false); } });

$("#delete").addEventListener("click", async () => {
  const t = state.current; if (!t || t.preset) return;
  if (!confirm(`Delete "${t.title}"? This can't be undone.`)) return;
  performer.stop(true);
  try {
    await deleteDoc(doc(tracksCol(), t.id));
    if (state.favs.has(t.id)) setDoc(favsDoc(), { ids: arrayRemove(t.id) }, { merge: true }).catch(() => {});
    toast("Track deleted"); show("home");
  } catch { toast("Couldn't delete that track. Try again."); }
});
