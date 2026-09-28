// Elissa Revision – secure server function.
// Holds the Anthropic API key, checks the user is signed in, applies a daily limit,
// and turns revision notes (text, photos, PDFs) into a track.

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const MODEL = "claude-sonnet-5";
const DAILY_LIMIT = 25;          // tracks per person per day – keeps costs predictable
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

Also write 5 to 10 key facts (plain sentences, straight from the notes) and a 5-question multiple-choice quiz with 4 options each, testing facts from the notes.

Return ONLY a JSON object, with no markdown and no other text, in exactly this shape:
{
  "title": "catchy track title, max 6 words",
  "subject": "the subject",
  "topic": "the topic in a few words",
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
    sections,
    keyFacts: (Array.isArray(raw.keyFacts) ? raw.keyFacts : []).map(f => str(f, 300)).filter(Boolean).slice(0, 12),
    quiz,
  };
}

exports.makeTrack = onCall(
  { region: "europe-west2", secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: "512MiB", maxInstances: 3 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to make a track.");
    const uid = request.auth.uid;
    const { text = "", files = [], style = "rap", level = "KS3", subject = "" } = request.data || {};

    if (typeof text !== "string" || text.length > MAX_TEXT) throw new HttpsError("invalid-argument", "Those notes are too long. Split them into smaller chunks.");
    if (!Array.isArray(files) || files.length > MAX_FILES) throw new HttpsError("invalid-argument", `Add up to ${MAX_FILES} files per track.`);
    if (!text.trim() && !files.length) throw new HttpsError("invalid-argument", "Add a photo, a file or some notes first.");

    // Daily limit
    const db = getFirestore();
    const today = new Date().toISOString().slice(0, 10);
    const usageRef = db.doc(`usage/${uid}_${today}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(usageRef);
      const count = snap.exists ? snap.data().count || 0 : 0;
      if (count >= DAILY_LIMIT) throw new HttpsError("resource-exhausted", `That's ${DAILY_LIMIT} tracks today – brilliant effort! Try again tomorrow.`);
      tx.set(usageRef, { uid, date: today, count: count + 1 }, { merge: true });
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
