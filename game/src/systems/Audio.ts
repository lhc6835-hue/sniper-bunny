import * as THREE from 'three';

const BASE = `${import.meta.env.BASE_URL}assets/audio/`;

/** Kenney CC0 SFX (sfx/) + OpenGameArt CC0 music (music/). */
const SFX = [
  'footstep_grass_000', 'footstep_grass_001', 'footstep_grass_002', 'footstep_grass_003', 'footstep_grass_004',
  'impactSoft_heavy_000', 'impactSoft_heavy_001', 'impactSoft_medium_000',
  'impactMetal_heavy_000', 'impactMetal_heavy_001', 'impactMetal_heavy_002',
  'impactMetal_light_000', 'impactMetal_light_001', 'impactMetal_light_002', 'impactMetal_medium_000',
  'impactBell_heavy_000', 'impactBell_heavy_001', 'impactPunch_heavy_000', 'impactPunch_heavy_001', 'impactPunch_medium_000',
  'impactPlate_light_000', 'impactPlate_medium_000', 'impactGlass_light_000', 'impactGlass_light_001', 'impactTin_medium_000',
  'impactMining_000', 'impactGeneric_light_000',
  'laserLarge_000', 'laserLarge_001', 'laserLarge_002', 'laserSmall_000',
  'explosionCrunch_000', 'explosionCrunch_001', 'explosionCrunch_002', 'lowFrequency_explosion_000', 'lowFrequency_explosion_001',
  'forceField_000', 'forceField_001', 'thrusterFire_000', 'impactMetal_000', 'impactMetal_001', 'computerNoise_000',
  'tick_001', 'tick_002', 'click_002', 'confirmation_001', 'confirmation_002', 'error_004', 'glitch_001',
  'phaserDown1', 'phaserUp1', 'phaserUp3', 'powerUp2', 'powerUp7', 'zapThreeToneUp', 'lowDown',
  'drawKnife1', 'drawKnife2', 'drawKnife3', 'knifeSlice', 'knifeSlice2', 'metalClick', 'metalLatch',
  'beltHandle1', 'beltHandle2', 'cloth1', 'cloth2', 'cloth3', 'chop', 'dropLeather',
  'jingles_HIT00', 'jingles_HIT05', 'jingles_HIT10', 'jingles_STEEL00', 'jingles_STEEL05', 'jingles_NES03', 'jingles_PIZZI10', 'jingles_SAX05',
] as const;

type Sfx = (typeof SFX)[number];
type MusicName = 'menu' | 'battle';

interface PlayOpts {
  gain?: number;
  rate?: number;
  rateVar?: number;
  pos?: THREE.Vector3;
  reverb?: number;
  delay?: number;
  /** World sounds get pitched down by slow motion. */
  world?: boolean;
}

/** Sample-based audio with a little synthesis for layers no pack provides (rifle crack, charge hum). */
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private bus!: GainNode;
  private musicBus!: GainNode;
  private lowpass!: BiquadFilterNode;
  private reverbSend!: GainNode;
  private noiseBuf!: AudioBuffer;
  private readonly raw = new Map<string, ArrayBuffer>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private music: { name: MusicName; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wantMusic: MusicName | null = null;
  private chargeOsc: OscillatorNode | null = null;
  private chargeOsc2: OscillatorNode | null = null;
  private chargeGain: GainNode | null = null;
  private readonly listenerPos = new THREE.Vector3();
  private readonly listenerRight = new THREE.Vector3(1, 0, 0);
  private slow = 0;
  volume = 0.8;
  musicVolume = 0.32;

  /** Fetch all files (no AudioContext needed yet). */
  async preload(): Promise<void> {
    const files: Array<[string, string]> = [
      ...SFX.map((n) => [n, `${BASE}sfx/${n}.ogg`] as [string, string]),
      ['music:menu', `${BASE}music/menu.ogg`],
      ['music:battle', `${BASE}music/battle.ogg`],
    ];
    await Promise.all(
      files.map(async ([name, url]) => {
        try {
          const res = await fetch(url);
          if (res.ok) this.raw.set(name, await res.arrayBuffer());
        } catch {
          // Missing audio must never block the game.
        }
      }),
    );
  }

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
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 20000;
    this.bus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.bus.connect(this.lowpass);
    this.musicBus.connect(this.lowpass);
    this.lowpass.connect(comp);
    comp.connect(this.master);
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
    const reverb = ctx.createConvolver();
    const irLen = ctx.sampleRate * 2.2;
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let c = 0; c < 2; c += 1) {
      const ch = ir.getChannelData(c);
      for (let i = 0; i < irLen; i += 1) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3.2);
    }
    reverb.buffer = ir;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.3;
    this.reverbSend.connect(reverb);
    reverb.connect(this.lowpass);
    // Decode everything in the background.
    for (const [name, data] of this.raw) {
      ctx.decodeAudioData(data.slice(0)).then(
        (buf) => {
          this.buffers.set(name, buf);
          if (this.wantMusic && name === `music:${this.wantMusic}` && !this.music) this.playMusic(this.wantMusic);
        },
        () => {},
      );
    }
    this.startWind();
  }

  setListener(pos: THREE.Vector3, yaw: number): void {
    this.listenerPos.copy(pos);
    this.listenerRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
  }

  /** 0 = normal, 1 = full slow motion. */
  setSlowmo(k: number): void {
    this.slow = k;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 20000 * Math.pow(1 - k * 0.92, 2.2) + 600 * k;
    this.lowpass.frequency.setTargetAtTime(f, t, 0.05);
    if (this.music) this.music.src.playbackRate.setTargetAtTime(1 - k * 0.22, t, 0.08);
  }

  // ---------------- music ----------------

  playMusic(name: MusicName | null): void {
    this.wantMusic = name;
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.music?.name === name) return;
    const t = ctx.currentTime;
    if (this.music) {
      const old = this.music;
      old.gain.gain.setTargetAtTime(0, t, 0.4);
      setTimeout(() => old.src.stop(), 2500);
      this.music = null;
    }
    if (!name) return;
    const buf = this.buffers.get(`music:${name}`);
    if (!buf) return; // will start once decoded
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.gain.setTargetAtTime(name === 'menu' ? 0.8 : 1, t, 0.5);
    src.connect(gain).connect(this.musicBus);
    src.start();
    this.music = { name, src, gain };
  }

  /** Duck music under big moments. */
  private duck(amount: number, time: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.musicBus.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.musicVolume * amount, t + 0.03);
    g.setTargetAtTime(this.musicVolume, t + time, 0.25);
  }

  // ---------------- primitives ----------------

  private route(pos: THREE.Vector3 | undefined, gain: number, reverb: number): GainNode | null {
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

  /** Play one of the given samples (random variant). */
  play(names: Sfx | Sfx[], o: PlayOpts = {}): void {
    const list = Array.isArray(names) ? names : [names];
    const name = list[Math.floor(Math.random() * list.length)];
    const buf = this.buffers.get(name);
    const out = this.route(o.pos, o.gain ?? 1, o.reverb ?? 0.1);
    if (!buf || !out || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const v = o.rateVar ?? 0.06;
    let rate = (o.rate ?? 1) * (1 + (Math.random() - 0.5) * 2 * v);
    if (o.world) rate *= 1 - this.slow * 0.35;
    src.playbackRate.value = rate;
    src.connect(out);
    src.start(this.ctx.currentTime + (o.delay ?? 0));
  }

  private noise(dest: AudioNode, t0: number, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number, attack = 0.002): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
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

  // ---------------- player weapon ----------------

  shot(): void {
    // No rifle samples in the Kenney packs: synthesized crack + Kenney low explosion for body.
    const o = this.route(undefined, 0.9, 0.9);
    if (o) {
      const t = this.ctx!.currentTime;
      this.noise(o, t, 0.035, 'highpass', 3000, 2000, 0.7, 1.1, 0.001);
      this.noise(o, t, 0.35, 'lowpass', 7000, 400, 0.8, 0.7, 0.002);
      this.tone(o, t, 0.3, 'sine', 150, 40, 0.8, 0.002);
    }
    this.play(['lowFrequency_explosion_000', 'lowFrequency_explosion_001'], { gain: 0.9, rate: 1.35, reverb: 0.6 });
    this.play('impactMetal_heavy_000', { gain: 0.25, rate: 1.6 });
    this.duck(0.45, 0.25);
  }

  dry(): void {
    this.play('click_002', { gain: 0.6, rate: 0.8 });
  }

  boltOpen(): void {
    this.play('metalLatch', { gain: 0.8, rate: 1.15 });
  }

  boltClose(): void {
    this.play('metalClick', { gain: 0.9, rate: 0.95 });
    this.play(['impactMetal_light_000', 'impactMetal_light_001', 'impactMetal_light_002'], { gain: 0.45, rate: 1.3 });
  }

  boltLock(): void {
    this.play('click_002', { gain: 0.5, rate: 1.2 });
  }

  casing(): void {
    this.play(['impactGlass_light_000', 'impactGlass_light_001'], { gain: 0.25, rate: 2.2, delay: 0.32, rateVar: 0.1 });
    this.play('impactTin_medium_000', { gain: 0.15, rate: 2.6, delay: 0.47, rateVar: 0.1 });
  }

  magOut(): void {
    this.play(['beltHandle1', 'beltHandle2'], { gain: 0.8, rate: 1.1 });
  }

  magIn(): void {
    this.play('impactPlate_light_000', { gain: 0.7, rate: 1.2 });
    this.play('metalClick', { gain: 0.5, rate: 1.3, delay: 0.03 });
  }

  magSlap(): void {
    this.play('impactSoft_medium_000', { gain: 0.7 });
  }

  daggerDraw(): void {
    this.play(['drawKnife1', 'drawKnife2', 'drawKnife3'], { gain: 0.9, reverb: 0.3 });
  }

  chargeStart(): void {
    this.play('forceField_000', { gain: 0.35, rate: 1.2 });
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.chargeStop();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.1);
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
    this.chargeOsc2.frequency.setTargetAtTime(440 + k * 900, t, 0.02);
  }

  chargeStop(): void {
    if (!this.ctx) return;
    if (this.chargeGain) {
      this.chargeGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.03);
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
    this.play(['cloth1', 'cloth2', 'cloth3'], { gain: 1, rate: 0.75 });
    this.play('thrusterFire_000', { gain: 0.35, rate: 1.6 });
  }

  slash(): void {
    this.play(['knifeSlice', 'knifeSlice2'], { gain: 1, rate: 0.9, reverb: 0.2 });
  }

  slashHit(): void {
    this.play('chop', { gain: 1, rate: 0.8 });
    this.play(['impactMetal_heavy_000', 'impactMetal_heavy_001', 'impactMetal_heavy_002'], { gain: 0.9, reverb: 0.5 });
    this.play(['explosionCrunch_000', 'explosionCrunch_001'], { gain: 0.5, rate: 1.1 });
    this.duck(0.3, 0.5);
  }

  // ---------------- movement ----------------

  whoosh(strength = 1): void {
    this.play(['cloth1', 'cloth2', 'cloth3'], { gain: 0.7 * strength, rate: 0.6, rateVar: 0.1 });
  }

  jump(): void {
    this.play(['cloth1', 'cloth2'], { gain: 0.4, rate: 1.1 });
  }

  land(impact: number): void {
    this.play(['footstep_grass_000', 'footstep_grass_002', 'footstep_grass_004'], { gain: 0.5 + impact * 0.5, rate: 0.85 });
    if (impact > 0.2) this.play(['impactSoft_heavy_000', 'impactSoft_heavy_001'], { gain: impact });
  }

  step(): void {
    this.play(['footstep_grass_000', 'footstep_grass_001', 'footstep_grass_002', 'footstep_grass_003', 'footstep_grass_004'], { gain: 0.3, rateVar: 0.1 });
  }

  // ---------------- feedback ----------------

  hitmarker(): void {
    this.play('tick_001', { gain: 0.7 });
    this.play(['impactMetal_light_000', 'impactMetal_light_001'], { gain: 0.35, rate: 1.4 });
  }

  headshot(): void {
    this.play(['impactBell_heavy_000', 'impactBell_heavy_001'], { gain: 0.8, rate: 1.25, reverb: 0.5, rateVar: 0.02 });
    this.play(['impactMetal_heavy_000', 'impactMetal_heavy_001'], { gain: 0.8 });
    this.play(['explosionCrunch_000', 'explosionCrunch_002'], { gain: 0.45, rate: 1.3 });
    this.duck(0.35, 0.6);
  }

  kill(): void {
    this.play('confirmation_001', { gain: 0.6 });
  }

  hurt(): void {
    this.play(['impactPunch_heavy_000', 'impactPunch_heavy_001'], { gain: 0.9, rate: 0.9 });
  }

  punchHit(): void {
    this.play(['impactPunch_heavy_000', 'impactPunch_heavy_001'], { gain: 1 });
    this.play('impactSoft_heavy_000', { gain: 0.7 });
  }

  slowIn(): void {
    this.play('phaserDown1', { gain: 0.5, rate: 0.7, reverb: 0.4 });
  }

  slowOut(): void {
    this.play('phaserUp1', { gain: 0.35, rate: 0.8 });
  }

  waveStart(): void {
    this.play('jingles_STEEL05', { gain: 0.8, rateVar: 0 });
    this.play('lowDown', { gain: 0.4, rate: 0.7 });
  }

  waveClear(): void {
    this.play('jingles_HIT10', { gain: 0.9, rateVar: 0 });
  }

  gameOver(): void {
    this.play('jingles_PIZZI10', { gain: 0.9, rateVar: 0 });
  }

  uiClick(): void {
    this.play('click_002', { gain: 0.6, rateVar: 0 });
  }

  // ---------------- enemies ----------------

  world(name: string, pos: THREE.Vector3): void {
    const w = { pos, world: true };
    switch (name) {
      case 'spawnBeam':
        this.play('forceField_001', { ...w, gain: 0.9 });
        this.play('thrusterFire_000', { ...w, gain: 0.6, rate: 0.7, delay: 0.5 });
        break;
      case 'land':
        this.play(['lowFrequency_explosion_000', 'lowFrequency_explosion_001'], { ...w, gain: 1.1 });
        this.play('impactMining_000', { ...w, gain: 0.8, rate: 0.7 });
        break;
      case 'charge':
        this.play('phaserUp3', { ...w, gain: 0.8, rate: 0.9 });
        break;
      case 'plasma':
        this.play(['laserLarge_000', 'laserLarge_001', 'laserLarge_002'], { ...w, gain: 1, reverb: 0.3 });
        break;
      case 'plasmaHitWall':
        this.play(['impactMetal_000', 'impactMetal_001'], { ...w, gain: 0.7 });
        break;
      case 'punchSwing':
        this.play(['cloth1', 'cloth2', 'cloth3'], { ...w, gain: 0.8, rate: 0.7, delay: 0.1 });
        break;
      case 'explode':
        this.play(['explosionCrunch_000', 'explosionCrunch_001', 'explosionCrunch_002'], { ...w, gain: 1.2, reverb: 0.5 });
        this.play('lowFrequency_explosion_000', { ...w, gain: 1 });
        break;
      default:
        break;
    }
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
    g.gain.value = 0.025;
    src.connect(f).connect(g).connect(this.bus);
    src.start();
  }

  dispose(): void {
    void this.ctx?.close();
  }
}
