import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Input } from '../core/Input';
import { Loop } from '../core/Loop';
import { createRenderer } from '../core/Renderer';
import { Assets } from '../world/Assets';
import { World } from '../world/World';
import { Player, PLAYER } from '../player/Player';
import { Viewmodel, type VmEvent } from '../view/Viewmodel';
import { Enemies } from '../enemies/Enemies';
import type { Robot } from '../enemies/Robot';
import { Vfx } from '../systems/Vfx';
import { Audio } from '../systems/Audio';
import { LOW_FX, PostFx } from '../systems/PostFx';
import { Hud } from '../ui/Hud';
import { clamp, damp, easeInCubic, lerp, noise1, Spring } from '../utils/math';

type GameState = 'loading' | 'menu' | 'playing' | 'paused' | 'dead';

const BASE_FOV = 80;
const SCOPE_FOV = 19;
const SENS = 0.0021;
const FOCUS_MAX = 100;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 900);
  private readonly input: Input;
  private readonly assets = new Assets();
  private world!: World;
  private readonly player = new Player();
  private vm!: Viewmodel;
  private enemies!: Enemies;
  private vfx!: Vfx;
  private readonly audio = new Audio();
  private post!: PostFx;
  private readonly hud = new Hud();
  private readonly loop: Loop;

  private state: GameState = 'loading';
  private elapsed = 0;
  private frame = 0;
  // Time
  private timeScale = 1;
  private hitstop = 0;
  private killPulse = 0;
  private slowAmount = 0;
  private wasSlow = false;
  // Focus
  private focus = FOCUS_MAX;
  private focusEmpty = false;
  private focusIdle = 0;
  // Camera FX
  private trauma = 0;
  private readonly shake = new THREE.Vector3();
  private readonly camKick = new Spring(220, 18);
  private fovPunch = 0;
  private damageFx = 0;
  private aberration = 0;
  private speedFx = 0;
  // Dagger
  private charging = false;
  private charge = 0;
  private lockTarget: Robot | null = null;
  private dashTarget: Robot | null = null;
  private dashSlashed = false;
  private lungeTimer = -1;
  // Scoring
  private score = 0;
  private combo = 0;
  private comboTimer = 0;
  private headshots = 0;
  private daggerKills = 0;
  private shotsFired = 0;
  private shotsHit = 0;
  private deadTimer = 0;
  private lastRange = Infinity;
  private botMode = false;
  private debugTimeMul = 1;
  private godMode = false;

  private readonly tmpV = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    this.renderer.localClippingEnabled = true;
    this.input = new Input(canvas);
    this.loop = new Loop((dt) => this.update(dt), () => {});
    this.installTestHooks();
    this.bindUi();
  }

  async init(): Promise<void> {
    const fill = document.getElementById('loading-fill')!;
    await this.assets.load((p) => (fill.style.width = `${(p * 100).toFixed(0)}%`));
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.35;

    this.world = new World(this.scene, this.assets);
    this.vfx = new Vfx(this.scene);
    this.vm = new Viewmodel(env);
    this.vm.onEvent = (e) => this.onVmEvent(e);
    this.post = new PostFx(this.renderer, this.scene, this.camera, this.vm.scene, this.vm.camera);
    this.enemies = new Enemies(this.scene, this.assets, this.world.colliders, this.vfx, this.world.spawnPoints, {
      onPlayerHit: (d, from, kind) => this.damagePlayer(d, from, kind),
      onWaveStart: (n) => {
        this.hud.banner_(`WAVE ${n}`, n === 1 ? '로봇들이 내려온다!' : `로봇 ${Math.min(4 + n * 2, 22)}기 접근 중`);
        this.audio.waveStart();
      },
      onWaveClear: (n) => {
        const bonus = 500 * n;
        this.score += bonus;
        this.hud.banner_('WAVE CLEAR', `보너스 +${bonus}`, 2600);
        this.audio.waveClear();
        this.player.hp = Math.min(PLAYER.maxHp, this.player.hp + 35);
        this.focus = FOCUS_MAX;
      },
      onSound: (name, pos) => this.audio.world(name, pos),
    });
    this.player.onEvent = (e, data) => {
      if (e === 'flip') {
        this.audio.whoosh(1);
        this.fovPunch += 7;
        this.speedFx = Math.max(this.speedFx, 0.35);
        this.vfx.ring(this.player.pos.clone().setY(this.player.pos.y + 0.05), new THREE.Vector3(0, 1, 0), '#ffffff', 2.2, 0.35);
        void data;
      } else if (e === 'jump') this.audio.jump();
      else if (e === 'land') {
        const impact = data ?? 0;
        this.audio.land(impact);
        this.vm.land(0.3 + impact);
        this.trauma = Math.min(1, this.trauma + impact * 0.35);
        if (impact > 0.3) {
          this.vfx.ring(this.player.pos.clone().setY(0.05), new THREE.Vector3(0, 1, 0), '#e8dcc0', 3, 0.4);
          this.vfx.smoke(this.player.pos.clone().setY(0.2), 4, 0.8, 0.9, undefined, 0.25, '#c8b89a');
        }
      } else if (e === 'step') this.audio.step();
    };

    this.resize();
    // Warm up shaders with a robot in view so first spawn doesn't hitch.
    const warm = this.enemies.spawnNow('ranged', new THREE.Vector3(0, -50, 0));
    this.renderer.compile(this.scene, this.camera);
    this.post.render(0);
    warm.alive = false;
    warm.removeT = 0;

    this.state = 'menu';
    document.getElementById('loading')!.classList.add('hidden');
    document.getElementById('menu')!.classList.remove('hidden');
    this.player.reset();
    this.loop.start();
  }

  private bindUi(): void {
    document.getElementById('play-btn')!.addEventListener('click', () => this.startOrResume());
    document.getElementById('retry-btn')!.addEventListener('click', () => {
      this.newRun();
      this.startOrResume();
    });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.state === 'playing' && !this.botMode) this.pause();
    });
  }

  private startOrResume(): void {
    this.audio.unlock();
    this.input.requestLock();
    if (this.state === 'menu') this.newRun();
    this.state = 'playing';
    document.getElementById('overlay')!.classList.add('hidden');
    this.hud.show(true);
  }

  private pause(): void {
    this.state = 'paused';
    this.audio.chargeStop();
    this.charging = false;
    const overlay = document.getElementById('overlay')!;
    overlay.classList.remove('hidden');
    document.getElementById('menu')!.classList.remove('hidden');
    document.getElementById('gameover')!.classList.add('hidden');
    (document.getElementById('play-btn') as HTMLButtonElement).textContent = '계속하기';
  }

  private newRun(): void {
    this.player.reset();
    this.enemies.reset(Math.floor(performance.now()) % 10000);
    this.score = 0;
    this.combo = 0;
    this.headshots = 0;
    this.daggerKills = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.focus = FOCUS_MAX;
    this.focusEmpty = false;
    this.timeScale = 1;
    this.hitstop = 0;
    this.killPulse = 0;
    this.damageFx = 0;
    this.charging = false;
    this.charge = 0;
    this.dashTarget = null;
    this.godMode = false;
    this.vm.ammo = 5;
    this.hud.reset();
    document.getElementById('gameover')!.classList.add('hidden');
  }

  // ===================================================================

  private update(rawDt: number): void {
    const realDt = rawDt * this.debugTimeMul;
    this.frame += 1;
    this.resize();
    if (this.state === 'loading') return;
    const playing = this.state === 'playing';
    const dying = this.state === 'dead';
    if (playing) this.elapsed += realDt;

    // ---------- Look ----------
    const mouse = this.input.consumeMouse();
    if (playing && !this.player.dashing) {
      const zoomK = this.camera.fov / BASE_FOV;
      this.player.look(mouse.dx, mouse.dy, SENS * (this.vm.ads > 0.5 ? zoomK * 1.15 : 1));
    }

    // ---------- Actions ----------
    const canAct = playing && !this.player.dashing;
    if (canAct) this.handleWeapons(realDt);

    // ---------- Time scale ----------
    const adsSlow = playing && this.vm.ads > 0.3 && this.input.isDown('Mouse2') && !this.focusEmpty;
    const chargeSlow = playing && this.charging && !this.focusEmpty;
    let target = 1;
    if (adsSlow) target = 0.28;
    if (chargeSlow) target = 0.16;
    if (this.player.dashing) target = 1;
    if (this.killPulse > 0) {
      this.killPulse -= realDt;
      target = Math.min(target, 0.22);
    }
    if (dying) target = 0.25;
    if (!playing && !dying) target = 1;
    this.timeScale = damp(this.timeScale, target, target < this.timeScale ? 14 : 7, realDt);
    const slowNow = this.timeScale < 0.7;
    if (slowNow && !this.wasSlow) this.audio.slowIn();
    if (!slowNow && this.wasSlow) this.audio.slowOut();
    this.wasSlow = slowNow;
    this.slowAmount = clamp((1 - this.timeScale) / 0.8, 0, 1);

    // Focus drain/regen (real time)
    if (playing) {
      if (adsSlow || chargeSlow) {
        this.focus -= (chargeSlow ? 20 : 11) * realDt;
        this.focusIdle = 0;
        if (this.focus <= 0) {
          this.focus = 0;
          this.focusEmpty = true;
        }
      } else {
        this.focusIdle += realDt;
        if (this.focusIdle > 0.7) this.focus = Math.min(FOCUS_MAX, this.focus + 16 * realDt);
        if (this.focusEmpty && this.focus > 25) this.focusEmpty = false;
      }
    }

    let hs = 1;
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      hs = 0.04;
    }
    const worldDt = playing || dying ? realDt * this.timeScale * hs : 0;
    const playerDt = playing ? realDt * lerp(this.timeScale, 1, 0.5) * hs : 0;

    // ---------- Simulation ----------
    if (playing) {
      this.player.update(playerDt, this.input, this.world.colliders, canAct);
      this.updateDash();
      // HP regen
      if (this.elapsed - this.player.lastDamageTime > 4 && this.player.hp > 0) {
        this.player.hp = Math.min(PLAYER.maxHp, this.player.hp + 9 * realDt);
      }
      this.comboTimer -= worldDt;
      if (this.comboTimer <= 0 && this.combo > 0) {
        this.combo = 0;
        this.hud.setCombo(0);
      }
    }
    if (playing || dying) this.enemies.update(worldDt, this.player, this.elapsed);
    this.vfx.update(worldDt || realDt * 0.0);
    this.world.update(this.elapsed, this.player.pos);

    // ---------- Viewmodel ----------
    this.vm.update(realDt, {
      adsHeld: playing && this.input.isDown('Mouse2'),
      moveAmount: this.player.moveAmount,
      grounded: this.player.grounded,
      mouseDX: mouse.dx,
      mouseDY: mouse.dy,
      flipT: this.player.flipT,
      charge: this.charge,
      elapsed: this.elapsed,
    });

    // ---------- Camera ----------
    this.trauma = Math.max(0, this.trauma - realDt * 1.6);
    const s = this.trauma * this.trauma;
    const tt = this.elapsed * 28;
    this.shake.set(noise1(tt, 1) * 0.045 * s, noise1(tt, 2) * 0.045 * s, noise1(tt, 3) * 0.07 * s);
    this.camKick.update(realDt);
    this.player.applyCamera(this.camera, this.camKick.value, this.shake);
    if (dying) {
      this.deadTimer += realDt;
      const k = Math.min(1, this.deadTimer / 1.2);
      this.camera.position.y -= easeInCubic(k) * 1.2;
      this.camera.rotation.z += k * 0.5;
      if (this.deadTimer > 1.6 && document.getElementById('gameover')!.classList.contains('hidden')) this.showGameOver();
    }
    this.fovPunch = damp(this.fovPunch, 0, 6, realDt);
    const adsK = easeInCubic(this.vm.ads);
    const fov = lerp(BASE_FOV, SCOPE_FOV, adsK) + this.fovPunch * (1 - adsK * 0.8) + this.slowAmount * 2 * (1 - adsK);
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
      this.vfx.setPointScale(this.canvas.clientHeight, fov);
    }
    this.audio.setListener(this.camera.position, this.player.yaw);
    this.audio.setSlowmo(this.slowAmount);

    // ---------- HUD + Post ----------
    this.updateHud();
    this.damageFx = damp(this.damageFx, 0, 3, realDt);
    this.aberration = damp(this.aberration, 0, 8, realDt);
    this.speedFx = damp(this.speedFx, this.player.dashing ? 1 : 0, this.player.dashing ? 30 : 6, realDt);
    const u = this.post.grade.uniforms;
    u.uSlow.value = this.slowAmount;
    u.uDamage.value = Math.max(this.damageFx, this.player.hp < 30 ? 0.25 + Math.sin(this.elapsed * 5) * 0.1 : 0);
    u.uAberration.value = this.aberration * 0.012 + this.slowAmount * 0.002;
    u.uCharge.value = this.charging ? this.charge : 0;
    u.uSpeed.value = this.speedFx;
    this.post.bloom.strength = 0.5 + this.slowAmount * 0.25;
    this.post.render(realDt);

    this.input.endFrame();
    this.publishDiagnostics();
  }

  // ===================================================================

  private handleWeapons(realDt: number): void {
    const inp = this.input;
    // Dagger charge
    if (inp.wasPressed('KeyF') && !this.charging && this.lungeTimer < 0) {
      if (this.vm.startDagger()) {
        this.charging = true;
        this.charge = 0;
        this.audio.chargeStart();
      }
    }
    if (this.charging) {
      this.charge = Math.min(1, this.charge + realDt / 0.55);
      this.audio.chargeSet(this.charge);
      const range = 12 + this.charge * 24;
      this.camera.getWorldDirection(this.fwd);
      this.lockTarget = this.enemies.findDaggerTarget(this.camera.position, this.fwd, range);
      if (!inp.isDown('KeyF')) this.releaseDagger();
      return;
    }
    this.lockTarget = null;

    if (inp.wasPressed('KeyR')) this.vm.reload();
    if (inp.wasPressed('Mouse0')) {
      if (this.vm.canFire()) this.fire();
      else if (this.vm.ammo === 0 && !this.vm.reloading) {
        this.audio.dry();
        this.vm.reload();
      }
    }
  }

  private fire(): void {
    this.vm.fire();
    this.audio.shot();
    this.shotsFired += 1;
    const ads = this.vm.ads > 0.9;
    const ro = this.camera.position.clone();
    const rd = this.camera.getWorldDirection(new THREE.Vector3());
    // Hip-fire spread
    if (!ads) {
      const spread = THREE.MathUtils.degToRad(1.4 + this.player.moveAmount * 1.5 + (this.player.grounded ? 0 : 1.2));
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      rd.addScaledVector(up, Math.sin(a) * r).addScaledVector(right, Math.cos(a) * r).normalize();
    }
    const normal = new THREE.Vector3();
    const worldDist = this.world.colliders.raycast(ro, rd, 400, normal);
    const hit = this.enemies.raycast(ro, rd, 400);

    // Muzzle in world space
    const muzzle = ads
      ? ro.clone().addScaledVector(rd, 0.8).add(new THREE.Vector3(0, -0.06, 0).applyQuaternion(this.camera.quaternion))
      : this.camera.localToWorld(this.vm.getMuzzleView(new THREE.Vector3()).multiplyScalar(0.9));

    let end: THREE.Vector3;
    if (hit && hit.dist < worldDist) {
      end = ro.clone().addScaledVector(rd, hit.dist);
      const res = this.enemies.shoot(hit, rd, end);
      this.shotsHit += 1;
      this.onSniperHit(res, hit.robot);
    } else {
      const d = Number.isFinite(worldDist) ? worldDist : 300;
      end = ro.clone().addScaledVector(rd, d);
      if (Number.isFinite(worldDist)) {
        this.vfx.burst(end, normal, 18, 6, '#ffe2b0', 0.4, 0.8, 0.05);
        this.vfx.smoke(end, 3, 0.7, 1.1, normal.clone().multiplyScalar(1.5), 0.4, '#bfae94');
        this.vfx.ring(end.clone().addScaledVector(normal, 0.03), normal, '#ffe2b0', 0.6, 0.18);
      }
    }
    this.vfx.tracer(muzzle, end, '#ffe2a8', ads ? 0.025 : 0.035, 0.28);
    this.vfx.flashLight(muzzle, '#ffb35c', 10, 0.08);
    this.vfx.smoke(muzzle, 2, 0.3, 0.8, rd.clone().multiplyScalar(2), 0.25);
    // Camera kick
    this.camKick.impulse(ads ? 1.6 : 3.2);
    this.trauma = Math.min(1, this.trauma + (ads ? 0.18 : 0.28));
    this.fovPunch += ads ? 0 : 3;
    this.aberration = Math.max(this.aberration, 0.5);
  }

  private onSniperHit(res: 'headshot' | 'kill' | 'hit', robot: Robot): void {
    const air = !this.player.grounded;
    if (res === 'headshot') {
      this.headshots += 1;
      this.bumpCombo();
      const pts = Math.round((300 + (air ? 150 : 0)) * this.comboMul());
      this.score += pts;
      this.hud.popup(air ? 'AIR HEADSHOT' : 'HEADSHOT', pts, 'head');
      this.hud.feed(`🐰 ⟶ ${robot.kind === 'melee' ? '돌격 로봇' : '포격 로봇'}  [헤드샷]`);
      this.hud.hit('head');
      this.audio.headshot();
      this.hitstop = 0.06;
      this.killPulse = 0.35;
      this.trauma = Math.min(1, this.trauma + 0.3);
      this.focus = Math.min(FOCUS_MAX, this.focus + 18);
    } else if (res === 'kill') {
      this.bumpCombo();
      const pts = Math.round(120 * this.comboMul());
      this.score += pts;
      this.hud.popup('KILL', pts, 'kill');
      this.hud.feed(`🐰 ⟶ ${robot.kind === 'melee' ? '돌격 로봇' : '포격 로봇'}`);
      this.hud.hit('kill');
      this.audio.kill();
      this.hitstop = 0.04;
    } else {
      this.hud.hit('hit');
      this.audio.hitmarker();
    }
  }

  private comboMul(): number {
    return 1 + (this.combo - 1) * 0.25;
  }

  private bumpCombo(): void {
    this.combo += 1;
    this.comboTimer = 4;
    this.hud.setCombo(this.combo);
  }

  private releaseDagger(): void {
    this.charging = false;
    this.audio.chargeStop();
    const target = this.charge >= 0.2 ? this.lockTarget : null;
    this.lockTarget = null;
    this.vm.release(!!target);
    this.audio.dash();
    this.fovPunch += 16;
    this.aberration = 1;
    this.dashSlashed = false;
    if (target) {
      const tp = target.root.position;
      const dir = this.tmpV.subVectors(tp, this.player.pos).setY(0);
      const dist = dir.length();
      dir.normalize();
      const end = tp.clone().addScaledVector(dir, -1.1);
      end.y = Math.max(0, tp.y);
      this.player.yaw = Math.atan2(-dir.x, -dir.z);
      this.player.startDash(end, clamp(dist / 55, 0.1, 0.3));
      this.dashTarget = target;
    } else {
      // Quick lunge forward
      this.player.forward(this.fwd);
      const end = this.player.pos.clone().addScaledVector(this.fwd, 4 + this.charge * 3);
      this.player.startDash(end, 0.14);
      this.dashTarget = null;
    }
    this.charge = 0;
  }

  private updateDash(): void {
    const p = this.player.dashProgress;
    if (p < 0 && !this.dashSlashed && this.player.dashing === false && this.dashTarget === null) return;
    if (p >= 0.55 && !this.dashSlashed) {
      this.dashSlashed = true;
      this.vm.slash();
      this.audio.slash();
    }
    if (!this.player.dashing && this.dashSlashed) {
      // Arrived: resolve the strike
      this.dashSlashed = false;
      this.player.forward(this.fwd);
      const right = new THREE.Vector3(-this.fwd.z, 0, this.fwd.x);
      let victims: Robot[] = [];
      if (this.dashTarget && this.dashTarget.alive) victims = [this.dashTarget];
      // Also cleave anything else in front within reach
      for (const r of this.enemies.robots) {
        if (!r.alive || victims.includes(r)) continue;
        const to = r.root.position.clone().sub(this.player.pos).setY(0);
        const d = to.length();
        if (d < 2.8 && to.normalize().dot(this.fwd) > 0.3 && Math.abs(r.root.position.y - this.player.pos.y) < 2) victims.push(r);
      }
      for (const r of victims) {
        this.enemies.killDagger(r, this.fwd.clone(), right);
        this.daggerKills += 1;
        this.bumpCombo();
        const pts = Math.round(250 * this.comboMul());
        this.score += pts;
        this.hud.popup(victims.length > 1 ? 'CLEAVE' : 'SLICED', pts, 'dagger');
        this.hud.feed(`🐰 🗡 ${r.kind === 'melee' ? '돌격 로봇' : '포격 로봇'}`, true);
      }
      if (victims.length) {
        this.hud.hit('kill');
        this.audio.slashHit();
        this.hitstop = 0.1;
        this.killPulse = 0.45;
        this.trauma = Math.min(1, this.trauma + 0.55);
        this.fovPunch += 6;
        this.focus = Math.min(FOCUS_MAX, this.focus + 12);
        this.aberration = 1;
      }
      this.dashTarget = null;
    }
  }

  private damagePlayer(dmg: number, from: THREE.Vector3, kind: 'plasma' | 'punch'): void {
    if (this.state !== 'playing' || this.player.dashing) return;
    if (!this.godMode) this.player.hp -= dmg;
    this.player.lastDamageTime = this.elapsed;
    this.damageFx = 1;
    this.trauma = Math.min(1, this.trauma + (kind === 'punch' ? 0.6 : 0.4));
    this.camKick.impulse(-2);
    if (kind === 'punch') {
      this.audio.punchHit();
      const push = this.player.pos.clone().sub(from).setY(0).normalize().multiplyScalar(9);
      this.player.vel.add(push);
      this.player.vel.y = Math.max(this.player.vel.y, 4);
      this.player.grounded = false;
    }
    this.audio.hurt();
    // Direction indicator
    const d = from.clone().sub(this.player.pos);
    this.player.forward(this.fwd);
    const right = new THREE.Vector3(-this.fwd.z, 0, this.fwd.x);
    this.hud.damageFrom(Math.atan2(d.dot(right), d.dot(this.fwd)));
    if (this.player.hp <= 0) this.die();
  }

  private die(): void {
    this.state = 'dead';
    this.deadTimer = 0;
    this.charging = false;
    this.audio.chargeStop();
  }

  private showGameOver(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    const acc = this.shotsFired ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0;
    document.querySelector('#gameover .stats')!.innerHTML =
      `점수 <b>${this.score.toLocaleString()}</b><br/>도달 웨이브 <b>${this.enemies.wave}</b> · 처치 <b>${this.enemies.kills}</b><br/>헤드샷 <b>${this.headshots}</b> · 단검 킬 <b>${this.daggerKills}</b> · 명중률 <b>${acc}%</b>`;
    document.getElementById('overlay')!.classList.remove('hidden');
    document.getElementById('menu')!.classList.add('hidden');
    document.getElementById('gameover')!.classList.remove('hidden');
  }

  private onVmEvent(e: VmEvent): void {
    switch (e) {
      case 'boltOpen': this.audio.boltOpen(); break;
      case 'boltClose': this.audio.boltClose(); break;
      case 'boltLock': this.audio.boltLock(); break;
      case 'casing': this.audio.casing(); break;
      case 'magOut': this.audio.magOut(); break;
      case 'magIn': this.audio.magIn(); break;
      case 'magSlap': this.audio.magSlap(); break;
      case 'daggerDraw': this.audio.daggerDraw(); break;
      case 'sniperReady': this.audio.boltLock(); break;
      default: break;
    }
  }

  private updateHud(): void {
    if (this.state === 'loading') return;
    const scoped = this.vm.scoped;
    if (scoped) {
      const rd = this.camera.getWorldDirection(new THREE.Vector3());
      const hit = this.enemies.raycast(this.camera.position, rd, 400);
      const w = this.world.colliders.raycast(this.camera.position, rd, 400);
      this.lastRange = hit && hit.dist < w ? hit.dist : w;
    }
    this.hud.setScope(scoped, this.lastRange);
    const spread = 7 + this.player.moveAmount * 10 + (this.player.grounded ? 0 : 9) + this.camKick.value * 6;
    this.hud.setCrosshair(spread, this.vm.busy, !scoped && !this.vm.isDaggerMode);
    this.hud.setCharge(this.charge, this.charging);
    if (this.lockTarget) {
      const p = this.lockTarget.headCenter.clone().lerp(this.lockTarget.bodyB, 0.5).project(this.camera);
      const x = (p.x * 0.5 + 0.5) * this.canvas.clientWidth;
      const y = (-p.y * 0.5 + 0.5) * this.canvas.clientHeight;
      this.hud.setLock(x, y, p.z < 1, this.elapsed);
    } else this.hud.setLock(0, 0, false, 0);
    this.hud.setStatus(Math.max(1, this.enemies.wave), this.enemies.aliveCount, this.score);
    this.hud.setHp(this.player.hp, PLAYER.maxHp);
    this.hud.setFocus(this.focus / FOCUS_MAX, this.focusEmpty);
    this.hud.setJumps(this.player.grounded ? 3 : this.player.airFlipsLeft);
    this.hud.setAmmo(this.vm.ammo, 5, this.vm.reloading, this.vm.isDaggerMode);
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const dpr = LOW_FX ? 0.5 : Math.min(window.devicePixelRatio || 1, 1.75);
    const bw = Math.floor(w * dpr);
    const bh = Math.floor(h * dpr);
    if (this.canvas.width === bw && this.canvas.height === bh) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vm?.setAspect(w / h);
    this.post?.setSize(w, h, dpr);
    this.vfx?.setPointScale(h, this.camera.fov);
  }

  // ===================================================================

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      score: this.score,
      targetScore: 0,
      complete: this.state === 'dead',
      player: {
        position: { x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z },
        speed: Math.hypot(this.player.vel.x, this.player.vel.z),
      },
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: Math.min(window.devicePixelRatio || 1, 1.75),
      },
    };
    (window as unknown as { __GAME_STATE__: unknown }).__GAME_STATE__ = {
      state: this.state,
      wave: this.enemies?.wave,
      alive: this.enemies?.aliveCount,
      hp: this.player.hp,
      focus: this.focus,
      ammo: this.vm?.ammo,
      timeScale: this.timeScale,
      ads: this.vm?.ads,
      grounded: this.player.grounded,
      airFlipsLeft: this.player.airFlipsLeft,
      headshots: this.headshots,
      daggerKills: this.daggerKills,
      kills: this.enemies?.kills,
      locked: !!this.lockTarget,
    };
  }

  private installTestHooks(): void {
    const game = this;
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: () => {},
      setState: (name: string) => {
        if (!['active-play', 'menu'].includes(name)) throw new Error(`Unknown test state: ${name}`);
        if (name === 'active-play') {
          game.botMode = true;
          game.input.allowUnlocked = true;
          game.newRun();
          game.state = 'playing';
          document.getElementById('overlay')!.classList.add('hidden');
          game.hud.show(true);
        }
        return { state: name };
      },
      setPausedForScreenshot: () => {},
      setReducedMotion: () => {},
      hideDebugUi: () => {},
    };
    (window as unknown as { __GAME__: unknown }).__GAME__ = {
      start: () => window.__THREE_GAME_TEST_HOOKS__!.setState('active-play'),
      key: (code: string, down: boolean) => game.input.inject(code, down),
      mouse: (dx: number, dy: number) => game.input.injectMouse(dx, dy),
      look: (yaw: number, pitch: number) => {
        game.player.yaw = yaw;
        game.player.pitch = pitch;
      },
      teleport: (x: number, y: number, z: number) => game.player.pos.set(x, y, z),
      spawn: (kind: 'melee' | 'ranged', x: number, z: number, facing = 0) => game.enemies.spawnNow(kind, new THREE.Vector3(x, 0, z), facing),
      clearWaves: () => {
        game.enemies.waveState = 'idle';
      },
      robots: () => game.enemies.robots.map((r) => ({ kind: r.kind, alive: r.alive, state: r.state, pos: r.root.position.toArray(), head: r.headCenter.toArray() })),
      aimAt: (x: number, y: number, z: number) => {
        const d = new THREE.Vector3(x, y, z).sub(game.camera.position);
        game.player.yaw = Math.atan2(-d.x, -d.z);
        game.player.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      },
      debug: () => ({ scene: game.scene, camera: game.camera, vm: game.vm, THREE, boxes: game.world.colliders.boxes }),
      /** Find a yaw from (x,z) with no collider for `dist` meters. */
      clearYaw: (x: number, z: number, dist: number) => {
        for (let i = 0; i < 72; i += 1) {
          const yaw = (i / 72) * Math.PI * 2;
          const d = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
          let ok = true;
          for (const h of [0.5, 1.5, 2.3]) {
            for (const off of [-1.5, 0, 1.5]) {
              const o = new THREE.Vector3(x + d.z * off, h, z - d.x * off);
              if (game.world.colliders.raycast(o, d, dist) < dist) ok = false;
            }
          }
          if (ok) return yaw;
        }
        return null;
      },
      timeMul: (k: number) => {
        game.debugTimeMul = k;
      },
      godMode: () => {
        game.godMode = true;
      },
      freezeEnemies: (on: boolean) => {
        game.enemies.paused = on;
      },
    };
  }
}
