// Elissa Revision – secure server function.
// Holds the Anthropic API key, checks the user is signed in, applies a daily limit,
// and turns revision notes (text, photos, PDFs) into a track.

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const crypto = require("crypto");

initializeApp();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const MODEL = "claude-sonnet-5";
const PROFILES = ["elissa"];      // lower-case, must match the app and firestore.rules
const DAILY_LIMIT = 25;          // tracks per person per day
const GLOBAL_DAILY_LIMIT = 40;   // tracks per day across everyone – a hard cap on cost
const MAX_FILES = 5;
const MAX_TEXT = 40000;

const STYLE_GUIDE = {
  rap: "Hip-hop rap: strong end rhymes plus internal rhymes, confident flow, call-and-response in the chorus.",
  pop: "Upbeat pop song: bright, simple rhymes and a big sing-along chorus.",
  chant: "Playground chant: very rhythmic, repetitive and easy to clap along to.",
  chill: "Laid-back lo-fi spoken word: calm, smooth, gentle rhymes.",
};
const LEVELS = {
  "KS2": "Key Stage 2 (ages 7–11)",
  "KS3": "Key Stage 3 (ages 11–14)",
  "GCSE": "GCSE (ages 14–16)",
  "A level": "A level (ages 16–18)",
};

function systemPrompt(style, level, subject) {
  return `You write memorable revision songs for a UK school pupil. You turn their revision notes into lyrics they can listen to, rap along with and learn from.

Rules:
- Accuracy comes first. Every fact in the lyrics must come from the notes. Never add facts that are not in the notes. If a fact won't rhyme neatly, keep the fact and simplify the rhyme.
- Keep key terms, names, dates, numbers, formulas and spellings exactly as they appear in the notes.
- Use UK English spelling and vocabulary.
- The pupil is a child: no swearing, violence, romance, put-downs, drugs, alcohol or weapons. Keep it upbeat and encouraging.
- Short lines of roughly 6 to 12 syllables, so each fits one bar of music. 4 to 8 lines per verse, 4 lines per chorus.
- Structure: intro (2 lines), verse, chorus, verse, chorus, then another verse and chorus if there is enough content, then outro (2 lines). Write the chorus out in full every time it appears, identical each time.
- The chorus holds the three or four most important ideas and is the catchiest part.
- Cover as much of the notes as you can. For long notes, prioritise what is most likely to come up in a test.
- Style: ${STYLE_GUIDE[style] || STYLE_GUIDE.rap}
- Level: ${LEVELS[level] || LEVELS.KS3}. Pitch vocabulary to this level.
- Subject: ${subject ? subject : "work it out from the notes and choose one of: Maths, English, Biology, Chemistry, Physics, Science, History, Geography, French, Spanish, German, Religious Studies, Computing, Music, Art, Drama, PE, Business, Other"}.

Also write:
- "explanation": 2 to 4 short paragraphs that explain the topic clearly and simply, like a great teacher talking to the pupil. Plain English, short sentences, one idea per paragraph, with a quick example where it helps. It will also be read aloud, so it must make sense when heard (for example write "x squared" rather than only "x²").
- 5 to 10 key facts (plain sentences, straight from the notes).
- A 5-question multiple-choice quiz with 4 options each, testing facts from the notes. Vary which option is correct.

Return ONLY a JSON object, with no markdown and no other text, in exactly this shape:
{
  "title": "catchy track title, max 6 words",
  "subject": "the subject",
  "topic": "the topic in a few words",
  "explanation": ["paragraph", "paragraph"],
  "sections": [ { "type": "intro|verse|chorus|bridge|outro", "lines": ["line", "line"] } ],
  "keyFacts": ["fact"],
  "quiz": [ { "question": "question", "options": ["a", "b", "c", "d"], "answer": 0, "explanation": "one short sentence" } ]
}
"answer" is the index (0–3) of the correct option.

If the notes are unreadable, blank, or not revision material, return {"error": "a short, friendly explanation for the pupil of what to do instead"}.`;
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no json");
  return JSON.parse(clean.slice(start, end + 1));
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function cleanTrack(raw) {
  const types = ["intro", "verse", "chorus", "bridge", "outro"];
  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map(s => ({
      type: types.includes(s?.type) ? s.type : "verse",
      lines: (Array.isArray(s?.lines) ? s.lines : []).map(l => str(l, 200)).filter(Boolean).slice(0, 12),
    }))
    .filter(s => s.lines.length)
    .slice(0, 14);
  if (!sections.length) throw new Error("no lyrics");
  const quiz = (Array.isArray(raw.quiz) ? raw.quiz : [])
    .map(q => ({
      question: str(q?.question, 300),
      options: (Array.isArray(q?.options) ? q.options : []).map(o => str(o, 200)).filter(Boolean).slice(0, 4),
      answer: Number.isInteger(q?.answer) ? q.answer : 0,
      explanation: str(q?.explanation, 400),
    }))
    .filter(q => q.question && q.options.length >= 2 && q.answer >= 0 && q.answer < q.options.length)
    .slice(0, 10);
  return {
    title: str(raw.title, 80) || "Revision track",
    subject: str(raw.subject, 40) || "Other",
    topic: str(raw.topic, 80),
    explanation: (Array.isArray(raw.explanation) ? raw.explanation : [raw.explanation]).map(p => str(p, 900)).filter(Boolean).slice(0, 5),
    sections,
    keyFacts: (Array.isArray(raw.keyFacts) ? raw.keyFacts : []).map(f => str(f, 300)).filter(Boolean).slice(0, 12),
    quiz,
  };
}

exports.makeTrack = onCall(
  { region: "europe-west2", secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: "512MiB", maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Reload the app and try again.");
    const { text = "", files = [], style = "rap", level = "KS3", subject = "", profile = "" } = request.data || {};
    if (!PROFILES.includes(profile)) throw new HttpsError("permission-denied", "Pick who's revising first.");

    if (typeof text !== "string" || text.length > MAX_TEXT) throw new HttpsError("invalid-argument", "Those notes are too long. Split them into smaller chunks.");
    if (!Array.isArray(files) || files.length > MAX_FILES) throw new HttpsError("invalid-argument", `Add up to ${MAX_FILES} files per track.`);
    if (!text.trim() && !files.length) throw new HttpsError("invalid-argument", "Add a photo, a file or some notes first.");

    // Daily limits (per person, plus an overall cap)
    const db = getFirestore();
    const today = new Date().toISOString().slice(0, 10);
    const personRef = db.doc(`usage/${profile}_${today}`);
    const allRef = db.doc(`usage/all_${today}`);
    await db.runTransaction(async (tx) => {
      const [p, a] = await Promise.all([tx.get(personRef), tx.get(allRef)]);
      const pc = p.exists ? p.data().count || 0 : 0;
      const ac = a.exists ? a.data().count || 0 : 0;
      if (pc >= DAILY_LIMIT || ac >= GLOBAL_DAILY_LIMIT) {
        throw new HttpsError("resource-exhausted", `That's ${pc} tracks today – brilliant effort! Try again tomorrow.`);
      }
      tx.set(personRef, { profile, date: today, count: pc + 1 }, { merge: true });
      tx.set(allRef, { date: today, count: ac + 1 }, { merge: true });
    });

    // Build the message
    const content = [];
    for (const f of files) {
      if (!f || typeof f.data !== "string") continue;
      if (f.type === "image" && /^image\/(jpeg|png|webp|gif)$/.test(f.mediaType)) {
        content.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } });
      } else if (f.type === "pdf") {
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
      }
    }
    content.push({
      type: "text",
      text: (text.trim() ? `Here are my revision notes:\n\n${text}\n\n` : "My revision notes are in the attached file(s).\n\n")
        + "Turn them into a revision track following your rules. Reply with the JSON only.",
    });

    let data;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4000,
          system: systemPrompt(style, level, subject),
          messages: [{ role: "user", content }],
        }),
      });
      data = await res.json();
      if (!res.ok) {
        console.error("Anthropic error", res.status, JSON.stringify(data));
        throw new HttpsError("internal", "The track maker is busy. Try again in a moment.");
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("Request failed", e);
      throw new HttpsError("internal", "Couldn't reach the track maker. Try again in a moment.");
    }

    const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    let parsed;
    try { parsed = parseJson(reply); }
    catch { console.error("Bad JSON", reply.slice(0, 500)); throw new HttpsError("internal", "The track came out garbled. Try again."); }

    if (parsed.error) throw new HttpsError("failed-precondition", str(parsed.error, 300));
    try { return cleanTrack(parsed); }
    catch { throw new HttpsError("internal", "The track came out garbled. Try again."); }
  }
);


// ======================= REAL SONGS (Google Lyria) =======================
const SONG_DAILY_LIMIT = 6;          // real songs per person per day
const LYRIA_MODELS = ["lyria-3.5", "lyria-3-pro-preview"];  // newest first, falls back if unavailable

const SONG_BEATS = {
  boombap: { secPerLine: 3.0, genre: "UK hip-hop with a boom bap beat", styles: "crisp boom bap drums, dusty jazzy piano chops, warm deep bassline, head-nodding groove, 90 BPM, polished modern production" },
  trap:    { secPerLine: 3.0, genre: "melodic trap", styles: "heavy 808 bass, rolling hi-hats, atmospheric pads, 140 BPM half-time feel, polished modern production" },
  grime:   { secPerLine: 3.4, genre: "UK grime", styles: "square-wave eski synth riffs, hard-hitting drums, energetic 140 BPM, London sound" },
  drill:   { secPerLine: 3.2, genre: "UK drill-style beat with clean, positive lyrics", styles: "sliding 808 bass, skippy hi-hats, piano melody, 142 BPM" },
  lofi:    { secPerLine: 3.4, genre: "lo-fi hip-hop", styles: "mellow electric piano, soft vinyl crackle, laid-back swung drums, 78 BPM, cosy study vibe" },
  afro:    { secPerLine: 3.2, genre: "afrobeats", styles: "afro-swing groove, log drum and shakers, bright guitar licks, 104 BPM, sunny uplifting energy" },
  pop:     { secPerLine: 3.4, genre: "upbeat modern pop", styles: "catchy synth hooks, punchy drums, bright and uplifting, 112 BPM, radio-ready production" },
};
const SONG_VOICES = {
  "female-rap":  "a confident female rapper with a British accent, clear crisp rap delivery, rhythmic flow",
  "male-rap":    "a confident male rapper with a British accent, clear crisp rap delivery, rhythmic flow",
  "female-sing": "a bright female singer with a British accent, clear catchy melody",
  "male-sing":   "a smooth male singer with a British accent, clear catchy melody",
};
const SECTION_LABEL = { intro: "Intro", verse: "Verse", chorus: "Chorus", bridge: "Bridge", outro: "Outro" };
const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function buildSongPrompt(sections, beatId, voiceId) {
  const beat = SONG_BEATS[beatId] || SONG_BEATS.boombap;
  const voice = SONG_VOICES[voiceId] || SONG_VOICES["female-rap"];
  const timeline = [{ startMs: 0, durMs: 4000, lineStart: 0, lines: 0 }];
  const timing = ["[0:00 - 0:04] Instrumental intro: the beat comes in, no vocals."];
  const lyrics = [];
  let t = 4000, lineStart = 0, verseNo = 0;
  sections.forEach((sec) => {
    if (sec.type === "verse") verseNo++;
    const label = sec.type === "verse" ? `Verse ${verseNo}` : (SECTION_LABEL[sec.type] || "Verse");
    const dur = Math.round(sec.lines.length * beat.secPerLine * (sec.type === "chorus" ? 1.15 : 1) * 1000);
    timing.push(`[${mmss(t)} - ${mmss(t + dur)}] ${label}${sec.type === "chorus" ? ": catchy memorable hook, layered vocals, full energy" : ""}`);
    lyrics.push(`[${label}]\n${sec.lines.join("\n")}`);
    timeline.push({ startMs: t, durMs: dur, lineStart, lines: sec.lines.length });
    t += dur; lineStart += sec.lines.length;
  });
  timing.push(`[${mmss(t)} - ${mmss(t + 4000)}] Outro: short instrumental ending, no vocals.`);
  const totalMs = t + 4000;
  const prompt = `Create a ${beat.genre} song, about ${mmss(totalMs)} long, to help a UK secondary school student revise.
Sound: ${beat.styles}.
Vocals: ${voice}. Every word must be clear and easy to understand. Clean, family-friendly, no swearing.
Use exactly the lyrics below, in order, without changing, adding or skipping any words. Sing or rap each chorus in full every time it appears.

Structure and timing:
${timing.join("\n")}

Lyrics:
${lyrics.join("\n\n")}`;
  return { prompt, timeline, totalMs };
}

async function callLyria(prompt) {
  let lastErr = null;
  for (const model of LYRIA_MODELS) {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY.value() },
      body: JSON.stringify({ model, input: prompt }),
    });
    const body = await res.text();
    if (res.ok) {
      const data = JSON.parse(body);
      let audio = null, mime = "audio/mpeg"; const text = [];
      for (const step of data.steps || []) {
        if (step.type !== "model_output") continue;
        for (const c of step.content || []) {
          if (c.type === "audio" && c.data) { audio = c.data; mime = c.mime_type || c.mimeType || mime; }
          else if (c.type === "text" && c.text) text.push(c.text);
        }
      }
      if (!audio && data.output_audio?.data) audio = data.output_audio.data;
      if (!audio) { console.error("Lyria returned no audio", body.slice(0, 600)); throw new HttpsError("failed-precondition", "The music studio couldn't make that one. Try a different beat or voice."); }
      return { audio: Buffer.from(audio, "base64"), mime, text: text.join("\n"), model };
    }
    console.error("Lyria error", model, res.status, body.slice(0, 800));
    lastErr = { status: res.status, body };
    if (res.status === 404 || (res.status === 400 && /model/i.test(body) && /not found|unsupported|invalid/i.test(body))) continue; // try the next model
    break;
  }
  const { status, body } = lastErr || {};
  if (status === 401 || status === 403) throw new HttpsError("failed-precondition", "The music key isn't working. Ask Dad to check the Gemini API key and billing.");
  if (status === 429) throw new HttpsError("resource-exhausted", "The music studio is busy. Wait a minute and try again.");
  if (/safety|blocked|SAFETY/i.test(body || "")) throw new HttpsError("failed-precondition", "The music studio didn't like some of the words. Try a different beat or voice.");
  throw new HttpsError("internal", "The music studio is busy. Try again in a moment.");
}

exports.makeSong = onCall(
  { region: "europe-west2", secrets: [GEMINI_API_KEY], timeoutSeconds: 540, memory: "1GiB", maxInstances: 2 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Reload the app and try again.");
    const { profile = "", trackId = "", sections = [], beat = "boombap", voice = "female-rap" } = request.data || {};
    if (!PROFILES.includes(profile)) throw new HttpsError("permission-denied", "Pick who's revising first.");
    if (typeof trackId !== "string" || !/^[\w-]{1,80}$/.test(trackId)) throw new HttpsError("invalid-argument", "That track can't be turned into a song.");
    const clean = (Array.isArray(sections) ? sections : []).slice(0, 14).map(s => ({
      type: SECTION_LABEL[s?.type] ? s.type : "verse",
      lines: (Array.isArray(s?.lines) ? s.lines : []).map(l => str(l, 200)).filter(Boolean).slice(0, 12),
    })).filter(s => s.lines.length);
    if (!clean.length) throw new HttpsError("invalid-argument", "This track has no lyrics to sing.");

    const db = getFirestore();
    const today = new Date().toISOString().slice(0, 10);
    const usageRef = db.doc(`usage/songs_${profile}_${today}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(usageRef);
      const count = snap.exists ? snap.data().count || 0 : 0;
      if (count >= SONG_DAILY_LIMIT) throw new HttpsError("resource-exhausted", `That's ${SONG_DAILY_LIMIT} songs today. Try again tomorrow – the beat and voice version still works.`);
      tx.set(usageRef, { profile, date: today, count: count + 1 }, { merge: true });
    });

    const { prompt, timeline, totalMs } = buildSongPrompt(clean, beat, voice);
    let result;
    try { result = await callLyria(prompt); }
    catch (e) { if (e instanceof HttpsError) throw e; console.error("Lyria request failed", e); throw new HttpsError("unavailable", "Couldn't reach the music studio. Try again in a moment."); }

    const ext = /wav/i.test(result.mime) ? "wav" : "mp3";
    const bucket = getStorage().bucket();
    const path = `songs/${profile}/${trackId}-${Date.now()}.${ext}`;
    const token = crypto.randomUUID();
    await bucket.file(path).save(result.audio, { resumable: false, contentType: ext === "wav" ? "audio/wav" : "audio/mpeg", metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;

    const songRef = db.doc(`profiles/${profile}/songs/${trackId}`);
    const old = await songRef.get();
    if (old.exists && old.data().path) bucket.file(old.data().path).delete().catch(() => {});
    const record = { url, path, beat, voice, timeline, totalMs, model: result.model, createdAt: FieldValue.serverTimestamp() };
    await songRef.set(record);
    return { url, beat, voice, timeline, totalMs };
  }
);
