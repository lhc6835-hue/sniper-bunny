import * as THREE from 'three';

type Ctx = AudioContext;

/** Procedural Web Audio SFX. Everything is synthesized; no external files. */
export class Audio {
  private ctx: Ctx | null = null;
  private master!: GainNode;
  private bus!: GainNode;
  private lowpass!: BiquadFilterNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private noiseBuf!: AudioBuffer;
  private wind: AudioBufferSourceNode | null = null;
  private chargeOsc: OscillatorNode | null = null;
  private chargeOsc2: OscillatorNode | null = null;
  private chargeGain: GainNode | null = null;
  private readonly listenerPos = new THREE.Vector3();
  private readonly listenerRight = new THREE.Vector3(1, 0, 0);
  volume = 0.8;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 20000;
    this.bus = ctx.createGain();
    this.bus.connect(this.lowpass);
    this.lowpass.connect(comp);
    comp.connect(this.master);
    this.master.connect(ctx.destination);
    // Noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
    // Reverb impulse
    this.reverb = ctx.createConvolver();
    const irLen = ctx.sampleRate * 2.4;
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let c = 0; c < 2; c += 1) {
      const ch = ir.getChannelData(c);
      for (let i = 0; i < irLen; i += 1) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3.2);
    }
    this.reverb.buffer = ir;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.35;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.lowpass);
    this.startWind();
  }

  setListener(pos: THREE.Vector3, yaw: number): void {
    this.listenerPos.copy(pos);
    this.listenerRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
  }

  /** 0 = normal, 1 = full slow motion muffling. */
  setSlowmo(k: number): void {
    if (!this.ctx) return;
    const f = 20000 * Math.pow(1 - k * 0.94, 2.2) + 500 * k;
    this.lowpass.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
  }

  // ---------------- primitives ----------------

  private out(pos?: THREE.Vector3, gain = 1, reverb = 0.2): AudioNode | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    const g = ctx.createGain();
    let vol = gain;
    let pan = 0;
    if (pos) {
      const d = pos.distanceTo(this.listenerPos);
      vol *= 1 / (1 + d * 0.07);
      const dir = pos.clone().sub(this.listenerPos).setY(0);
      if (dir.lengthSq() > 0.01) pan = Math.max(-0.85, Math.min(0.85, dir.normalize().dot(this.listenerRight)));
    }
    g.gain.value = vol;
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(this.bus);
    } else g.connect(this.bus);
    if (reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = reverb;
      g.connect(s);
      s.connect(this.reverbSend);
    }
    return g;
  }

  private noise(dest: AudioNode, t0: number, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number, attack = 0.002): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t0);
    filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(dest);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.05);
  }

  private tone(dest: AudioNode, t0: number, dur: number, type: OscillatorType, f0: number, f1: number, peak: number, attack = 0.003): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  // ---------------- player weapon ----------------

  shot(): void {
    const o = this.out(undefined, 1, 0.9);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.035, 'highpass', 3000, 2000, 0.7, 1.2, 0.001); // crack
    this.noise(o, t, 0.5, 'lowpass', 7000, 300, 0.8, 1.0, 0.002); // blast
    this.tone(o, t, 0.42, 'sine', 140, 38, 1.1, 0.002); // thump
    this.tone(o, t, 0.12, 'triangle', 420, 90, 0.35);
    this.noise(o, t + 0.05, 1.3, 'lowpass', 1400, 120, 0.5, 0.25, 0.04); // rolling echo
  }

  dry(): void {
    const o = this.out(undefined, 0.5, 0);
    if (!o) return;
    this.noise(o, this.now, 0.03, 'bandpass', 2500, 2000, 6, 0.6);
  }

  boltOpen(): void {
    const o = this.out(undefined, 0.7, 0.1);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.03, 'bandpass', 3200, 2600, 8, 0.9);
    this.tone(o, t, 0.06, 'square', 1900, 1500, 0.08);
    this.noise(o, t + 0.07, 0.07, 'bandpass', 1800, 900, 4, 0.6);
  }

  boltClose(): void {
    const o = this.out(undefined, 0.8, 0.1);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.05, 'bandpass', 1500, 700, 5, 1.0);
    this.tone(o, t, 0.05, 'triangle', 600, 200, 0.4);
    this.noise(o, t + 0.01, 0.03, 'bandpass', 4200, 3000, 10, 0.5);
  }

  boltLock(): void {
    const o = this.out(undefined, 0.6, 0.05);
    if (!o) return;
    this.noise(o, this.now, 0.025, 'bandpass', 3800, 3000, 9, 0.8);
  }

  casing(): void {
    const o = this.out(undefined, 0.35, 0.15);
    if (!o) return;
    const t = this.now + 0.32;
    for (let i = 0; i < 3; i += 1) {
      const tt = t + i * (0.11 - i * 0.025);
      const v = 0.5 / (i + 1);
      this.tone(o, tt, 0.12, 'sine', 4800 + Math.random() * 600, 4600, v, 0.001);
      this.tone(o, tt, 0.08, 'sine', 7200 + Math.random() * 600, 7000, v * 0.6, 0.001);
    }
  }

  magOut(): void {
    const o = this.out(undefined, 0.6, 0.05);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.04, 'bandpass', 2000, 1500, 6, 0.8);
    this.noise(o, t + 0.05, 0.12, 'lowpass', 1200, 300, 1, 0.3);
  }

  magIn(): void {
    const o = this.out(undefined, 0.8, 0.05);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.05, 'bandpass', 1300, 800, 5, 1.0);
    this.tone(o, t, 0.06, 'triangle', 300, 120, 0.4);
    this.noise(o, t + 0.03, 0.02, 'bandpass', 4000, 3500, 10, 0.5);
  }

  magSlap(): void {
    const o = this.out(undefined, 0.5, 0.05);
    if (!o) return;
    this.noise(o, this.now, 0.06, 'lowpass', 900, 200, 1, 0.8);
  }

  daggerDraw(): void {
    const o = this.out(undefined, 0.6, 0.3);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.25, 'highpass', 3000, 9000, 1, 0.5, 0.02);
    this.tone(o, t + 0.05, 0.6, 'sine', 3150, 3100, 0.12, 0.01);
    this.tone(o, t + 0.05, 0.5, 'sine', 4730, 4700, 0.06, 0.01);
  }

  chargeStart(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.chargeStop();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.1);
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = 110;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = 440;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    o1.connect(f);
    o2.connect(f);
    f.connect(g).connect(this.bus);
    o1.start();
    o2.start();
    this.chargeOsc = o1;
    this.chargeOsc2 = o2;
    this.chargeGain = g;
  }

  chargeSet(k: number): void {
    if (!this.ctx || !this.chargeOsc || !this.chargeOsc2) return;
    const t = this.ctx.currentTime;
    this.chargeOsc.frequency.setTargetAtTime(110 + k * 160, t, 0.03);
    this.chargeOsc2.frequency.setTargetAtTime(440 + k * 900 + Math.sin(t * 60) * 20 * k, t, 0.02);
  }

  chargeStop(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.chargeGain) {
      this.chargeGain.gain.setTargetAtTime(0.0001, t, 0.03);
      const o1 = this.chargeOsc;
      const o2 = this.chargeOsc2;
      setTimeout(() => {
        o1?.stop();
        o2?.stop();
      }, 200);
    }
    this.chargeOsc = this.chargeOsc2 = null;
    this.chargeGain = null;
  }

  dash(): void {
    const o = this.out(undefined, 0.8, 0.2);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.28, 'bandpass', 400, 3000, 1.5, 0.9, 0.03);
    this.tone(o, t, 0.25, 'sine', 180, 60, 0.4);
  }

  slash(): void {
    const o = this.out(undefined, 0.9, 0.25);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.18, 'bandpass', 1200, 6000, 2, 1.0, 0.01);
    this.tone(o, t + 0.02, 0.35, 'sine', 2600, 2400, 0.12);
  }

  slashHit(): void {
    const o = this.out(undefined, 1, 0.7);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.4, 'lowpass', 5000, 200, 0.7, 1.1, 0.001);
    this.tone(o, t, 0.5, 'sine', 120, 35, 1.0);
    this.tone(o, t, 0.9, 'sine', 880, 860, 0.18, 0.001);
    this.tone(o, t, 0.7, 'sine', 1397, 1380, 0.12, 0.001);
    this.noise(o, t + 0.02, 0.6, 'highpass', 6000, 3000, 1, 0.25, 0.01); // sizzle
  }

  // ---------------- movement ----------------

  whoosh(strength = 1): void {
    const o = this.out(undefined, 0.6 * strength, 0.1);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.5, 'bandpass', 300, 1400, 1.2, 0.8, 0.12);
  }

  jump(): void {
    const o = this.out(undefined, 0.35, 0);
    if (!o) return;
    this.noise(o, this.now, 0.1, 'lowpass', 900, 200, 1, 0.6);
  }

  land(impact: number): void {
    const o = this.out(undefined, 0.4 + impact * 0.6, 0.05);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.15 + impact * 0.2, 'lowpass', 1200, 120, 1, 0.9);
    this.tone(o, t, 0.2, 'sine', 90, 40, 0.5 * impact + 0.1);
  }

  step(): void {
    const o = this.out(undefined, 0.12, 0);
    if (!o) return;
    this.noise(o, this.now, 0.07, 'bandpass', 700 + Math.random() * 400, 300, 1.5, 0.6);
  }

  // ---------------- feedback ----------------

  hitmarker(): void {
    const o = this.out(undefined, 0.5, 0);
    if (!o) return;
    const t = this.now;
    this.tone(o, t, 0.05, 'square', 1300, 1200, 0.15, 0.001);
    this.noise(o, t, 0.05, 'bandpass', 2500, 2000, 4, 0.5);
  }

  headshot(): void {
    const o = this.out(undefined, 0.9, 0.4);
    if (!o) return;
    const t = this.now;
    this.tone(o, t, 0.7, 'sine', 1760, 1750, 0.35, 0.001);
    this.tone(o, t, 0.6, 'sine', 2637, 2630, 0.18, 0.001);
    this.tone(o, t + 0.06, 0.7, 'sine', 3520, 3510, 0.1, 0.001);
    this.noise(o, t, 0.1, 'bandpass', 1600, 900, 2, 0.9); // crunch
    this.noise(o, t, 0.4, 'lowpass', 3000, 200, 1, 0.5);
  }

  kill(): void {
    const o = this.out(undefined, 0.7, 0.3);
    if (!o) return;
    const t = this.now;
    this.tone(o, t, 0.4, 'sine', 1175, 1170, 0.25, 0.001);
    this.tone(o, t + 0.07, 0.45, 'sine', 1568, 1560, 0.2, 0.001);
  }

  hurt(): void {
    const o = this.out(undefined, 0.9, 0.1);
    if (!o) return;
    const t = this.now;
    this.tone(o, t, 0.25, 'sawtooth', 180, 60, 0.35);
    this.noise(o, t, 0.2, 'lowpass', 1500, 200, 1, 0.8);
  }

  slowIn(): void {
    const o = this.out(undefined, 0.7, 0.4);
    if (!o) return;
    const t = this.now;
    this.tone(o, t, 0.6, 'sine', 320, 55, 0.5, 0.01);
    this.noise(o, t, 0.5, 'lowpass', 3000, 150, 1, 0.4, 0.02);
  }

  slowOut(): void {
    const o = this.out(undefined, 0.5, 0.2);
    if (!o) return;
    const t = this.now;
    this.tone(o, t, 0.35, 'sine', 70, 280, 0.35, 0.01);
  }

  waveStart(): void {
    const o = this.out(undefined, 0.5, 0.5);
    if (!o) return;
    const t = this.now;
    for (const [i, f] of [220, 277, 330].entries()) {
      this.tone(o, t + i * 0.02, 1.4, 'sawtooth', f, f, 0.08, 0.05);
    }
    this.tone(o, t, 1.2, 'sine', 55, 50, 0.5, 0.05);
  }

  waveClear(): void {
    const o = this.out(undefined, 0.5, 0.5);
    if (!o) return;
    const t = this.now;
    [523, 659, 784, 1047].forEach((f, i) => this.tone(o, t + i * 0.09, 0.5, 'triangle', f, f, 0.25, 0.005));
  }

  // ---------------- enemies ----------------

  world(name: string, pos: THREE.Vector3): void {
    const o = this.out(pos, 1, 0.3);
    if (!o) return;
    const t = this.now;
    switch (name) {
      case 'spawnBeam':
        this.tone(o, t, 1.0, 'sawtooth', 80, 600, 0.12, 0.3);
        this.noise(o, t, 1.0, 'bandpass', 300, 3000, 2, 0.25, 0.4);
        break;
      case 'land':
        this.noise(o, t, 0.5, 'lowpass', 1500, 80, 1, 1.0);
        this.tone(o, t, 0.4, 'sine', 70, 30, 0.8);
        break;
      case 'charge':
        this.tone(o, t, 0.85, 'sine', 300, 1600, 0.25, 0.4);
        this.tone(o, t, 0.85, 'square', 150, 800, 0.05, 0.4);
        break;
      case 'plasma':
        this.tone(o, t, 0.25, 'square', 1100, 160, 0.3, 0.002);
        this.noise(o, t, 0.2, 'bandpass', 2000, 500, 2, 0.5);
        break;
      case 'plasmaHitWall':
        this.noise(o, t, 0.25, 'bandpass', 1800, 400, 1.5, 0.6);
        break;
      case 'punchSwing':
        this.noise(o, t + 0.12, 0.2, 'bandpass', 300, 1200, 1.5, 0.5, 0.05);
        break;
      case 'explode':
        this.noise(o, t, 1.4, 'lowpass', 2500, 60, 0.7, 1.2, 0.005);
        this.tone(o, t, 0.8, 'sine', 90, 25, 1.0);
        break;
      default:
        break;
    }
  }

  punchHit(): void {
    const o = this.out(undefined, 1, 0.1);
    if (!o) return;
    const t = this.now;
    this.noise(o, t, 0.2, 'lowpass', 900, 100, 1, 1.0);
    this.tone(o, t, 0.2, 'sine', 80, 40, 0.8);
  }

  private startWind(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 400;
    f.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.value = 0.04;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(f.frequency);
    src.connect(f).connect(g).connect(this.bus);
    src.start();
    lfo.start();
    this.wind = src;
  }

  dispose(): void {
    this.wind?.stop();
    void this.ctx?.close();
  }
}
