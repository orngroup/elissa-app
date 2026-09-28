// Elissa Revision – beat engine and voice performer.
// The beat is synthesised live with the Web Audio API (no audio files needed).
// Lyrics are delivered by the device's built-in voice, one line per bar, locked to the beat.

export const STYLES = {
  rap:   { bpm: 88,  rate: 1.1,  pitch: 1.0,  kick: [0, 6, 10],     snare: [4, 12], hat: [0,2,4,6,8,10,12,14], hatVol: 0.16 },
  pop:   { bpm: 104, rate: 1.05, pitch: 1.15, kick: [0, 4, 8, 12],  snare: [4, 12], hat: [2,6,10,14],          hatVol: 0.18 },
  chant: { bpm: 92,  rate: 1.0,  pitch: 1.1,  kick: [0, 8],         snare: [4, 12], hat: [],                    hatVol: 0 },
  chill: { bpm: 76,  rate: 0.95, pitch: 0.95, kick: [0, 10],        snare: [12],    hat: [0,4,8,12],           hatVol: 0.09 },
};
const BASS_NOTES = [55, 55, 49, 41.2]; // A, A, G, E – a simple loop under every bar

export class Beat {
  constructor() { this.ctx = null; this.timer = null; this.running = false; this.muted = false; }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.02);
  }

  get barDuration() { return (60 / this.bpm) * 4; }

  start(style, speed) {
    this.ensure();
    this.stop();
    this.style = STYLES[style] || STYLES.rap;
    this.bpm = this.style.bpm * speed;
    this.step = 0;
    this.startTime = this.ctx.currentTime + 0.1;
    this.nextTime = this.startTime;
    this.running = true;
    this.setMuted(this.muted);
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Time (in AudioContext seconds) of the next bar line
  nextBarTime() {
    const elapsed = this.ctx.currentTime - this.startTime;
    const bars = Math.max(0, Math.ceil((elapsed + 0.05) / this.barDuration));
    return this.startTime + bars * this.barDuration;
  }

  schedule() {
    const stepLen = 60 / this.bpm / 4;
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      const s = this.step % 16;
      const t = this.nextTime;
      const st = this.style;
      if (st.kick.includes(s)) { this.kick(t); if (this.onKick && !this.muted) setTimeout(this.onKick, Math.max(0, (t - this.ctx.currentTime) * 1000)); this.bass(t, BASS_NOTES[Math.floor(this.step / 16) % 4], stepLen * 3); }
      if (st.snare.includes(s)) this.snare(t);
      if (st.hat.includes(s)) this.hat(t, st.hatVol);
      this.nextTime += stepLen;
      this.step++;
    }
  }

  kick(t) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.45);
  }

  snare(t) {
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 1400;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    n.connect(f).connect(g).connect(this.master);
    n.start(t); n.stop(t + 0.22);
    const o = this.ctx.createOscillator(), og = this.ctx.createGain();
    o.type = "triangle"; o.frequency.value = 190;
    og.gain.setValueAtTime(0.3, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(og).connect(this.master);
    o.start(t); o.stop(t + 0.12);
  }

  hat(t, vol) {
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 7500;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(f).connect(g).connect(this.master);
    n.start(t); n.stop(t + 0.06);
  }

  bass(t, freq, dur) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "triangle"; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
}

// Picks a British voice where the device has one
let cachedVoice = null;
function pickVoice() {
  if (!("speechSynthesis" in window)) return null;
  if (cachedVoice) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  const gb = voices.filter(v => /en[-_]GB/i.test(v.lang));
  const preferred = ["Google UK English Female", "Serena", "Martha", "Kate", "Stephanie", "Libby", "Sonia", "Google UK English Male", "Daniel"];
  cachedVoice = preferred.map(n => gb.find(v => v.name.includes(n))).find(Boolean)
    || gb[0] || voices.find(v => /^en/i.test(v.lang)) || null;
  return cachedVoice;
}
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => { cachedVoice = null; pickVoice(); };

export class Performer {
  constructor({ onLine, onStop }) {
    this.beat = new Beat();
    this.onLine = onLine; this.onStop = onStop;
    this.lines = []; this.playing = false; this.pending = null; this.index = -1;
    this.voiceOn = true; this.loopChorus = false; this.speed = 1; this.style = "rap";
    this.run = 0; // guards against callbacks from a previous play-through
  }

  load(lines, style) { this.stop(); this.lines = lines; this.style = style || "rap"; this.index = -1; }

  get chorusLines() {
    const first = this.lines.find(l => l.type === "chorus");
    if (!first) return [];
    return this.lines.map((l, i) => (l.sectionIndex === first.sectionIndex ? i : -1)).filter(i => i >= 0);
  }

  nextIndex(i) {
    if (this.loopChorus) {
      const ch = this.chorusLines;
      if (ch.length) { const pos = ch.indexOf(i); return ch[(pos + 1) % ch.length]; }
    }
    return i + 1;
  }

  // Must be called from a tap so phones allow audio and speech
  play(from = 0) {
    this.stop(true);
    this.beat.ensure();
    if (this.voiceOn && "speechSynthesis" in window) {
      speechSynthesis.cancel();
      const unlock = new SpeechSynthesisUtterance(" ");
      unlock.volume = 0;
      speechSynthesis.speak(unlock);
    }
    this.playing = true;
    this.run++;
    this.beat.start(this.style, this.speed);
    if (this.loopChorus && this.lines[from]?.type !== "chorus" && this.chorusLines.length) from = this.chorusLines[0];
    this.scheduleLine(from, this.run);
  }

  stop(silent = false) {
    const was = this.playing;
    this.playing = false;
    this.run++;
    clearTimeout(this.pending); clearTimeout(this.fallback);
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.beat.stop();
    if (was && !silent) this.onStop?.();
  }

  scheduleLine(i, run) {
    if (!this.playing || run !== this.run) return;
    if (i >= this.lines.length) {
      const wait = Math.max(0, (this.beat.nextBarTime() - this.beat.ctx.currentTime) * 1000);
      this.pending = setTimeout(() => { if (run === this.run) this.stop(); }, wait);
      return;
    }
    const wait = Math.max(0, (this.beat.nextBarTime() - this.beat.ctx.currentTime) * 1000);
    this.pending = setTimeout(() => this.performLine(i, run), wait);
  }

  performLine(i, run) {
    if (!this.playing || run !== this.run) return;
    this.index = i;
    this.onLine?.(i);
    const text = this.lines[i].text;
    const next = () => { if (run === this.run) this.scheduleLine(this.nextIndex(i), run); };

    if (this.voiceOn && "speechSynthesis" in window) {
      const st = STYLES[this.style] || STYLES.rap;
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "en-GB"; }
      u.rate = st.rate * this.speed;
      u.pitch = st.pitch;
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(this.fallback); next(); };
      u.onend = finish; u.onerror = finish;
      // Some phones never fire "onend", so a safety timer moves things on
      const words = text.split(/\s+/).length;
      this.fallback = setTimeout(finish, (words * 0.42 / (st.rate * this.speed) + 1.5) * 1000);
      speechSynthesis.speak(u);
    } else {
      // Rap-along mode: two bars per line so she can perform it herself
      this.pending = setTimeout(next, this.beat.barDuration * 1000 * 1.5);
    }
  }
}
