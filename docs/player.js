// Elissa Revision – beat engine and rap performer (v2).
// Beats are synthesised live with the Web Audio API. Lyrics are delivered by the device's
// voices in rhythmic phrases that land on the beat, with an optional hype-man echo.

// ---------- beats ----------
// Steps are 16th notes in one bar (0–15). "lineBars" = how many bars each lyric line gets.
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI note → Hz

export const BEATS = {
  boombap: {
    name: "Boom bap", bpm: 90, swing: 0.14, lineBars: 1,
    kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], openHat: [14], hatVol: 0.14,
    bass: "kick", chords: [[57, 60, 64], [53, 57, 60], [50, 53, 57], [52, 56, 59]], chordSteps: [0], keys: "rhodes",
  },
  trap: {
    name: "Trap", bpm: 140, swing: 0, lineBars: 2,
    kick: [0, 3, 10], snare: [8], hat: [0, 2, 4, 6, 8, 10, 12, 14], roll: [12, 13, 14, 15], hatVol: 0.12,
    bass: "808", chords: [[61, 64, 68], [57, 61, 64], [59, 62, 66], [56, 59, 63]], chordSteps: [0], keys: "bell",
  },
  grime: {
    name: "Grime", bpm: 140, swing: 0, lineBars: 2,
    kick: [0, 10], snare: [8], hat: [4, 12], hatVol: 0.1,
    bass: "square", chords: [[62, 65, 69], [60, 63, 67], [58, 62, 65], [57, 60, 64]], chordSteps: [2, 6, 14], keys: "stab",
  },
  lofi: {
    name: "Lo-fi", bpm: 76, swing: 0.18, lineBars: 1,
    kick: [0, 9], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], hatVol: 0.07, crackle: true,
    bass: "kick", chords: [[57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65], [52, 55, 59, 62]], chordSteps: [0, 10], keys: "pad",
  },
  afro: {
    name: "Afrobeats", bpm: 104, swing: 0.06, lineBars: 1,
    kick: [0, 4, 8, 12], snare: [3, 7, 11, 14], hat: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], hatVol: 0.05, rim: true,
    bass: "kick", chords: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]], chordSteps: [0, 6, 10], keys: "rhodes",
  },
  none: { name: "No beat", bpm: 90, swing: 0, lineBars: 1, kick: [], snare: [], hat: [], hatVol: 0, chords: [], chordSteps: [], silent: true },
};
export const STYLE_BEAT = { rap: "boombap", pop: "afro", chant: "grime", chill: "lofi" };

export class Beat {
  constructor() { this.ctx = null; this.timer = null; this.muted = false; this.onKick = null; }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.5;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  get barDuration() { return (60 / this.bpm) * 4; }
  get lineDuration() { return this.barDuration * (this.beat.lineBars || 1); }

  start(beatId, speed) {
    this.ensure(); this.stop();
    this.beat = BEATS[beatId] || BEATS.boombap;
    this.bpm = this.beat.bpm * speed;
    this.step = 0;
    this.startTime = this.ctx.currentTime + 0.1;
    this.nextTime = this.startTime;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // Next time on a grid of `unit` seconds (used to land phrases on the beat)
  nextGrid(unit) {
    const elapsed = this.ctx.currentTime - this.startTime;
    const n = Math.max(0, Math.ceil((elapsed + 0.04) / unit));
    return this.startTime + n * unit;
  }

  schedule() {
    const b = this.beat, stepLen = 60 / this.bpm / 4;
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      const s = this.step % 16, bar = Math.floor(this.step / 16);
      const t = this.nextTime + (s % 2 === 1 ? stepLen * (b.swing || 0) : 0);
      if (!b.silent) {
        const chord = b.chords[bar % b.chords.length];
        if (b.kick.includes(s)) {
          this.kick(t, b.bass === "808" ? 0.9 : 1);
          if (b.bass === "kick") this.bassNote(t, NOTE(chord[0] - 24), stepLen * 3, "triangle");
          if (this.onKick && !this.muted) setTimeout(this.onKick, Math.max(0, (t - this.ctx.currentTime) * 1000));
        }
        if (b.bass === "808" && s === 0) this.eightOhEight(t, NOTE(chord[0] - 24), stepLen * 14);
        if (b.bass === "square" && [0, 3, 10].includes(s)) this.bassNote(t, NOTE(chord[0] - 24), stepLen * 2, "square");
        if (b.snare.includes(s)) b.rim ? this.rim(t) : this.snare(t);
        if (b.hat.includes(s)) this.hat(t, b.hatVol, 0.04);
        if (b.openHat?.includes(s)) this.hat(t, b.hatVol * 0.9, 0.18);
        if (b.roll && bar % 2 === 1 && b.roll.includes(s)) { this.hat(t + stepLen / 2, b.hatVol * 0.8, 0.03); }
        if (b.chordSteps.includes(s)) this.chord(t, chord, b.keys, stepLen);
        if (b.crackle && Math.random() < 0.35) this.crackle(t);
      }
      this.nextTime += stepLen; this.step++;
    }
  }

  env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  kick(t, vol = 1) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.45);
  }
  snare(t) {
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 1500;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.45, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    n.connect(f).connect(g).connect(this.master); n.start(t); n.stop(t + 0.22);
    const o = this.ctx.createOscillator(), og = this.ctx.createGain(); o.type = "triangle"; o.frequency.value = 185;
    og.gain.setValueAtTime(0.25, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.12);
  }
  rim(t) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(); o.type = "square"; o.frequency.value = 820;
    const f = this.ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1800;
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(f).connect(g).connect(this.master); o.start(t); o.stop(t + 0.06);
  }
  hat(t, vol, len) {
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 7500;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    n.connect(f).connect(g).connect(this.master); n.start(t); n.stop(t + len + 0.02);
  }
  crackle(t) {
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 3000 + Math.random() * 3000;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.03, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.01);
    n.connect(f).connect(g).connect(this.master); n.start(t, Math.random() * 0.5); n.stop(t + 0.02);
  }
  bassNote(t, freq, dur, type) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(); o.type = type; o.frequency.value = freq;
    const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = type === "square" ? 900 : 400;
    this.env(g, t, type === "square" ? 0.18 : 0.35, 0.01, dur);
    o.connect(f).connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  eightOhEight(t, freq, dur) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(); o.type = "sine";
    o.frequency.setValueAtTime(freq * 1.5, t); o.frequency.exponentialRampToValueAtTime(freq, t + 0.06);
    const sh = this.ctx.createWaveShaper(); const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(2.2 * x); } sh.curve = curve;
    this.env(g, t, 0.5, 0.01, dur);
    o.connect(sh).connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  chord(t, notes, kind, stepLen) {
    const dur = kind === "pad" ? stepLen * 10 : kind === "stab" ? stepLen * 0.9 : kind === "bell" ? stepLen * 6 : stepLen * 5;
    notes.forEach((n, i) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = kind === "stab" ? "square" : kind === "bell" ? "sine" : "triangle";
      const freq = NOTE(kind === "bell" ? n + 12 : n);
      o.frequency.value = freq; o.detune.value = (i - 1) * 4;
      const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = kind === "pad" ? 1200 : kind === "stab" ? 1800 : 2600;
      const vol = (kind === "stab" ? 0.05 : kind === "bell" ? 0.05 : 0.06) / Math.sqrt(notes.length);
      this.env(g, t, vol, kind === "pad" ? 0.25 : 0.01, dur);
      o.connect(f).connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.3);
    });
  }
}

// ---------- voices ----------
export const DELIVERY = {
  mc:     { name: "MC – fast and punchy", rate: 1.22, pitch: 1.0 },
  smooth: { name: "Smooth – low and laid-back", rate: 1.02, pitch: 0.8 },
  bright: { name: "Bright – high and bouncy", rate: 1.15, pitch: 1.3 },
  clear:  { name: "Clear – for learning", rate: 0.92, pitch: 1.0 },
};

export function englishVoices() {
  if (!("speechSynthesis" in window)) return [];
  const vs = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang));
  const score = (v) => (/en[-_]GB/i.test(v.lang) ? 0 : 1) * 10 + (/(Google|Natural|Enhanced|Premium|Neural)/i.test(v.name) ? 0 : 1);
  return vs.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}
export function findVoice(uri) {
  const vs = englishVoices();
  return vs.find(v => v.voiceURI === uri) || vs[0] || null;
}

// Split a line into two phrases, preferring a comma or the middle word
function phrases(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 6) return [text];
  const comma = words.findIndex((w, i) => i >= 2 && i <= words.length - 3 && /[,;:]$/.test(w));
  const cut = comma >= 0 ? comma + 1 : Math.ceil(words.length / 2);
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}
// Make maths symbols and signs read aloud naturally
export function speakable(t) {
  return String(t)
    .replace(/sin⁻¹/g, "inverse sine ").replace(/cos⁻¹/g, "inverse cos ").replace(/tan⁻¹/g, "inverse tan ")
    .replace(/²/g, " squared").replace(/³/g, " cubed").replace(/ⁿ/g, " to the power n")
    .replace(/±/g, " plus or minus ").replace(/√/g, " the square root of ").replace(/÷/g, " divided by ")
    .replace(/×/g, " times ").replace(/−/g, " minus ").replace(/π/g, " pi ").replace(/θ/g, " theta ")
    .replace(/(\d)°/g, "$1 degrees").replace(/½/g, " a half ").replace(/≥/g, " is at least ").replace(/≤/g, " is at most ")
    .replace(/ = /g, " equals ").replace(/ > /g, " is more than ").replace(/ < /g, " is less than ")
    .replace(/–/g, ", ").replace(/\s+/g, " ").trim();
}
const lastWord = (t) => (t.replace(/[^\w\s'-]/g, " ").trim().split(/\s+/).pop() || "");

export class Performer {
  constructor({ onLine, onStop, onEnd }) {
    this.beat = new Beat();
    this.onLine = onLine; this.onStop = onStop; this.onEnd = onEnd;
    this.lines = []; this.playing = false; this.index = -1; this.run = 0;
    this.voiceOn = true; this.loopChorus = false; this.speed = 1;
    this.beatId = "boombap"; this.delivery = "mc"; this.voiceURI = ""; this.hypeURI = ""; this.hype = true; this.flow = true;
  }

  load(lines, beatId) { this.stop(true); this.lines = lines; this.index = -1; if (beatId) this.beatId = beatId; }

  get chorusLines() {
    const first = this.lines.find(l => l.type === "chorus");
    if (!first) return [];
    return this.lines.map((l, i) => (l.sectionIndex === first.sectionIndex ? i : -1)).filter(i => i >= 0);
  }
  nextIndex(i) {
    if (this.loopChorus) { const ch = this.chorusLines; if (ch.length) return ch[(ch.indexOf(i) + 1) % ch.length]; }
    return i + 1;
  }

  unlockSpeech() {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u);
  }

  play(from = 0) {
    this.stop(true);
    this.beat.ensure();
    if (this.voiceOn) this.unlockSpeech();
    this.playing = true; this.run++;
    this.beat.start(this.beatId, this.speed);
    if (this.loopChorus && this.lines[from]?.type !== "chorus" && this.chorusLines.length) from = this.chorusLines[0];
    this.waitThen(this.beat.lineDuration, () => this.performLine(from, this.run), this.run);
  }

  stop(silent = false) {
    const was = this.playing;
    this.playing = false; this.run++;
    clearTimeout(this.pending); clearTimeout(this.fallback);
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.beat.stop();
    if (was && !silent) this.onStop?.();
  }

  waitThen(unit, fn, run) {
    const t = this.beat.nextGrid(unit);
    this.pending = setTimeout(() => { if (run === this.run && this.playing) fn(); }, Math.max(0, (t - this.beat.ctx.currentTime) * 1000));
  }

  say(text, { voiceURI, rate, pitch, volume = 1 }, done) {
    const u = new SpeechSynthesisUtterance(speakable(text));
    const v = findVoice(voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-GB";
    u.rate = Math.min(2, rate); u.pitch = pitch; u.volume = volume;
    let fin = false;
    const finish = () => { if (fin) return; fin = true; clearTimeout(this.fallback); done(); };
    u.onend = finish; u.onerror = finish;
    this.fallback = setTimeout(finish, (text.split(/\s+/).length * 0.45 / rate + 1.5) * 1000);
    speechSynthesis.speak(u);
  }

  performLine(i, run) {
    if (!this.playing || run !== this.run) return;
    if (i >= this.lines.length) {
      this.waitThen(this.beat.lineDuration, () => { this.stop(true); this.onEnd?.(); }, run);
      return;
    }
    this.index = i; this.onLine?.(i);
    const line = this.lines[i];
    const next = () => this.waitThen(this.flow ? this.beat.lineDuration / 2 : this.beat.lineDuration, () => this.performLine(this.nextIndex(i), run), run);

    if (!this.voiceOn || !("speechSynthesis" in window)) {
      this.pending = setTimeout(() => { if (run === this.run) this.waitThen(this.beat.lineDuration, () => this.performLine(this.nextIndex(i), run), run); }, this.beat.lineDuration * 1000 * 1.5);
      return;
    }
    const d = DELIVERY[this.delivery] || DELIVERY.mc;
    const main = { voiceURI: this.voiceURI, rate: d.rate * this.speed, pitch: d.pitch };
    const parts = this.flow ? phrases(line.text) : [line.text];
    const echo = this.hype && this.flow && (i % 2 === 1 || line.type === "chorus") ? lastWord(line.text) : "";

    const playPart = (k) => {
      if (run !== this.run || !this.playing) return;
      if (k >= parts.length) {
        if (echo) this.say(echo, { voiceURI: this.hypeURI || this.voiceURI, rate: 1.3, pitch: Math.min(2, d.pitch + 0.45), volume: 0.8 }, () => { if (run === this.run) next(); });
        else next();
        return;
      }
      const go = () => this.say(parts[k], main, () => playPart(k + 1));
      if (k === 0) go(); else this.waitThen(this.beat.lineDuration / 2, go, run);
    };
    playPart(0);
  }

  // Read text aloud clearly with no beat (for explanations)
  readClearly(texts, onDone) {
    this.stop(true);
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    this.run++; const run = this.run; this.reading = true;
    const d = DELIVERY.clear;
    const nextText = (k) => {
      if (run !== this.run) return;
      if (k >= texts.length) { this.reading = false; onDone?.(); return; }
      this.say(texts[k], { voiceURI: this.voiceURI, rate: d.rate, pitch: d.pitch }, () => setTimeout(() => nextText(k + 1), 350));
    };
    nextText(0);
  }
  stopReading() { this.run++; this.reading = false; clearTimeout(this.fallback); if ("speechSynthesis" in window) speechSynthesis.cancel(); }
}
