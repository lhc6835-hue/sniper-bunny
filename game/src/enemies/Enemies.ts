import * as THREE from 'three';
import { Robot, type CutPiece, type RobotKind } from './Robot';
import type { Assets } from '../world/Assets';
import type { Colliders } from '../world/Colliders';
import type { Vfx } from '../systems/Vfx';
import type { Player } from '../player/Player';
import { PLAYER } from '../player/Player';
import { raySphere, rayCapsule } from '../utils/math';
import { createSeededRandom } from '../utils/random';

export type HitPart = 'head' | 'body';
export interface RobotHit {
  robot: Robot;
  dist: number;
  part: HitPart;
}

interface Projectile {
  group: THREE.Group;
  vel: THREE.Vector3;
  life: number;
  prev: THREE.Vector3;
}

interface PendingSpawn {
  at: THREE.Vector3;
  kind: RobotKind;
  t: number;
}

interface Fountain {
  robot: Robot;
  bone: string;
  t: number;
  color: string;
}

interface Pivoted extends CutPiece {
  pivot: THREE.Object3D;
  radius: number;
}

export interface EnemyCallbacks {
  onPlayerHit(damage: number, from: THREE.Vector3, kind: 'plasma' | 'punch'): void;
  onWaveStart(wave: number): void;
  onWaveClear(wave: number): void;
  onSound(name: 'spawnBeam' | 'land' | 'charge' | 'plasma' | 'punchSwing' | 'explode' | 'plasmaHitWall' | 'robotStep', pos: THREE.Vector3): void;
}

const GRAVITY = 26;
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _avoid = new THREE.Vector3();

export class Enemies {
  readonly robots: Robot[] = [];
  private readonly pending: PendingSpawn[] = [];
  private readonly projectiles: Projectile[] = [];
  private readonly pieces: Pivoted[] = [];
  private readonly fountains: Fountain[] = [];
  private readonly delayed: Array<{ t: number; fn: () => void }> = [];
  private readonly lasers = new Map<Robot, THREE.Line>();
  private readonly projGeo = new THREE.SphereGeometry(0.16, 12, 10);
  private readonly projMat = new THREE.MeshBasicMaterial({ color: '#ffd0c0' });
  private readonly projHaloMat: THREE.SpriteMaterial;
  private readonly trailMat = new THREE.MeshBasicMaterial({ color: '#ff3a24', transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
  private readonly trailGeo: THREE.BufferGeometry;
  private rng = createSeededRandom(5);

  wave = 0;
  waveState: 'idle' | 'intermission' | 'active' = 'idle';
  waveTimer = 0;
  private toSpawn: RobotKind[] = [];
  private spawnTimer = 0;
  kills = 0;
  /** Test hook: robots stand still and do nothing. */
  paused = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly assets: Assets,
    private readonly colliders: Colliders,
    private readonly vfx: Vfx,
    private readonly spawnPoints: THREE.Vector3[],
    private readonly cb: EnemyCallbacks,
  ) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,240,220,1)');
    grd.addColorStop(0.3, 'rgba(255,80,40,0.8)');
    grd.addColorStop(1, 'rgba(255,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.projHaloMat = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.trailGeo = new THREE.CylinderGeometry(0.02, 0.13, 1, 8, 1, true);
    this.trailGeo.translate(0, -0.5, 0);
    this.trailGeo.rotateX(-Math.PI / 2);
  }

  get aliveCount(): number {
    return this.robots.filter((r) => r.alive).length + this.pending.length + this.toSpawn.length;
  }

  reset(seed = 5): void {
    for (const r of this.robots) this.removeRobot(r);
    this.robots.length = 0;
    this.pending.length = 0;
    for (const p of this.projectiles) this.scene.remove(p.group);
    this.projectiles.length = 0;
    for (const p of this.pieces) this.scene.remove(p.pivot);
    this.pieces.length = 0;
    this.fountains.length = 0;
    this.delayed.length = 0;
    this.wave = 0;
    this.waveState = 'intermission';
    this.waveTimer = 2.5;
    this.toSpawn = [];
    this.kills = 0;
    this.rng = createSeededRandom(seed);
  }

  private startWave(): void {
    this.wave += 1;
    const n = this.wave;
    const count = Math.min(4 + n * 2, 22);
    const rangedFrac = Math.min(0.55, 0.25 + n * 0.06);
    this.toSpawn = [];
    for (let i = 0; i < count; i += 1) this.toSpawn.push(this.rng() < rangedFrac ? 'ranged' : 'melee');
    if (n === 1) this.toSpawn = ['melee', 'ranged', 'melee', 'melee', 'ranged', 'melee'];
    this.waveState = 'active';
    this.spawnTimer = 0.5;
    this.cb.onWaveStart(n);
  }

  /** Spawn one robot immediately (for tests/screenshots). */
  spawnNow(kind: RobotKind, at: THREE.Vector3, facing = 0): Robot {
    const r = new Robot(this.assets.robot, kind);
    r.root.position.copy(at);
    r.facing = facing;
    r.root.rotation.y = facing;
    r.state = 'chase';
    r.play(kind === 'melee' ? 'Running' : 'Walking', 0);
    this.scene.add(r.root);
    this.robots.push(r);
    r.updateAnim(0);
    return r;
  }

  update(dt: number, player: Player, gameTime: number): void {
    // Wave flow
    if (this.waveState === 'intermission') {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) this.startWave();
    } else if (this.waveState === 'active') {
      const alive = this.robots.filter((r) => r.alive).length + this.pending.length;
      this.spawnTimer -= dt;
      const maxAlive = Math.min(4 + this.wave, 10);
      if (this.toSpawn.length && this.spawnTimer <= 0 && alive < maxAlive) {
        const kind = this.toSpawn.shift()!;
        this.queueSpawn(kind, player);
        this.spawnTimer = Math.max(0.6, 1.5 - this.wave * 0.08);
      }
      if (!this.toSpawn.length && alive === 0) {
        this.waveState = 'intermission';
        this.waveTimer = 5;
        this.cb.onWaveClear(this.wave);
      }
    }

    this.updatePending(dt);
    for (const r of this.robots) this.updateRobot(r, dt, player, gameTime);
    this.separate();
    this.updateProjectiles(dt, player);
    this.updatePieces(dt);
    this.updateFountains(dt);
    for (let i = this.delayed.length - 1; i >= 0; i -= 1) {
      const d = this.delayed[i];
      d.t -= dt;
      if (d.t <= 0) {
        this.delayed.splice(i, 1);
        d.fn();
      }
    }

    // Remove finished
    for (let i = this.robots.length - 1; i >= 0; i -= 1) {
      const r = this.robots[i];
      if (!r.alive && r.removeT <= 0) {
        this.removeRobot(r);
        this.robots.splice(i, 1);
      }
    }
  }

  private queueSpawn(kind: RobotKind, player: Player): void {
    // Prefer spawn points away from the player and not in their face.
    const candidates = this.spawnPoints
      .map((p) => ({ p, d: p.distanceTo(player.pos) }))
      .filter((c) => c.d > 16)
      .sort(() => this.rng() - 0.5);
    const at = (candidates[0]?.p ?? this.spawnPoints[0]).clone();
    at.x += (this.rng() - 0.5) * 4;
    at.z += (this.rng() - 0.5) * 4;
    this.pending.push({ at, kind, t: 0 });
    this.vfx.beam(at, kind === 'melee' ? '#ffb347' : '#ff4a3a', 1.25, 40, 0.7);
    this.vfx.ring(at.clone().setY(0.05), UP, kind === 'melee' ? '#ffb347' : '#ff4a3a', 2.2, 1.2);
    this.cb.onSound('spawnBeam', at);
  }

  private updatePending(dt: number): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const p = this.pending[i];
      p.t += dt;
      if (p.t >= 1.0) {
        const r = new Robot(this.assets.robot, p.kind);
        r.root.position.copy(p.at).setY(9);
        r.vel.set(0, -22, 0);
        r.state = 'spawn';
        r.stateT = 0;
        r.facing = Math.atan2(-p.at.x, -p.at.z);
        r.root.rotation.y = r.facing;
        this.scene.add(r.root);
        this.robots.push(r);
        this.pending.splice(i, 1);
      }
    }
  }

  private los(from: THREE.Vector3, to: THREE.Vector3): boolean {
    _v.subVectors(to, from);
    const d = _v.length();
    _v.divideScalar(d);
    return this.colliders.raycast(from, _v, d) >= d - 0.3;
  }

  private updateRobot(r: Robot, dt: number, player: Player, t: number): void {
    r.stateT += dt;
    r.attackCd -= dt;
    const pos = r.root.position;

    if (this.paused && r.alive) {
      if (r.currentClip !== 'Idle') r.play('Idle', 0.1);
      r.state = 'chase';
      r.updateAnim(dt);
      return;
    }
    if (!r.alive) {
      r.removeT -= dt;
      if (r.removeT < 1) pos.y -= dt * 0.8; // sink
      r.updateAnim(dt);
      return;
    }

    const toPlayer = _v2.subVectors(player.pos, pos);
    const dy = toPlayer.y;
    toPlayer.y = 0;
    const dist = toPlayer.length();
    if (dist > 1e-4) toPlayer.divideScalar(dist);
    const wantFace = Math.atan2(toPlayer.x, toPlayer.z);
    let moveSpeed = 0;
    let moveDir: THREE.Vector3 | null = null;

    switch (r.state) {
      case 'spawn': {
        r.vel.y -= GRAVITY * dt;
        if (r.grounded && r.stateT > 0.05 && r.currentClip !== 'Idle') {
          r.vel.set(0, 0, 0);
          r.play('Idle', 0.1);
          this.vfx.ring(pos.clone().setY(0.06), UP, '#ffe0b0', 4, 0.5);
          this.vfx.smoke(pos.clone().setY(0.3), 6, 1.4, 1.2, undefined, 0.35, '#c8b89a');
          this.vfx.burst(pos.clone().setY(0.2), UP, 20, 7, '#ffcf8a', 0.5, 1.6);
          this.cb.onSound('land', pos);
          r.stateT = 0;
          r.state = 'stagger'; // brief settle
        }
        break;
      }
      case 'stagger': {
        if (r.stateT > 0.45) {
          r.state = 'chase';
          r.stateT = 0;
          r.play(r.kind === 'melee' ? 'Running' : 'Walking', 0.25, r.kind === 'melee' ? 1.1 : 1);
        }
        break;
      }
      case 'chase': {
        r.facing = turnToward(r.facing, wantFace, 7 * dt);
        if (r.kind === 'melee') {
          moveSpeed = 5.0 + Math.min(this.wave, 8) * 0.18;
          moveDir = toPlayer;
          if (dist < 2.0 && Math.abs(dy) < 1.4 && r.attackCd <= 0) {
            r.state = 'punch';
            r.stateT = 0;
            r.punchDone = false;
            r.play('Punch', 0.08, 1.35);
            this.cb.onSound('punchSwing', pos);
          } else if (dy > 1.3 && dist < 7 && pos.y <= 0.05 && r.attackCd <= 0) {
            // Leap at a player perched above.
            r.vel.copy(toPlayer).multiplyScalar(Math.min(dist, 6) * 1.2);
            r.vel.y = Math.sqrt(2 * GRAVITY * (dy + 1.2));
            r.play('Jump', 0.1, 1.4);
            r.attackCd = 2.5;
          }
        } else {
          const ideal = dist > 24 || r.noLos > 1.2 ? 1 : dist < 10 ? -1 : 0;
          const strafe = _v.set(-toPlayer.z, 0, toPlayer.x).multiplyScalar(Math.sin(t * 0.7 + pos.x) > 0 ? 1 : -1);
          moveDir = strafe.multiplyScalar(0.6).addScaledVector(toPlayer, ideal).normalize();
          moveSpeed = ideal === 0 ? 1.6 : 2.8;
          if (r.attackCd <= 0 && dist < 42) {
            const muzzle = r.cannonMuzzle(new THREE.Vector3());
            const eye = player.pos.clone().setY(player.pos.y + 1.2);
            if (this.los(muzzle, eye)) {
              r.noLos = 0;
              r.state = 'aim';
              r.stateT = 0;
              r.aimCharge = 0;
              r.play('Idle', 0.2);
              this.cb.onSound('charge', pos);
            } else {
              r.attackCd = 0.4;
              r.noLos += 0.4;
            }
          }
        }
        break;
      }
      case 'aim': {
        r.facing = turnToward(r.facing, wantFace, 10 * dt);
        const AIM = Math.max(0.6, 0.95 - this.wave * 0.03);
        r.aimCharge = Math.min(1, r.stateT / AIM);
        this.updateLaser(r, player, true);
        if (r.stateT >= AIM) {
          this.fireProjectile(r, player);
          r.state = 'chase';
          r.stateT = 0;
          r.attackCd = 2.4 + this.rng() * 1.8 - Math.min(this.wave, 8) * 0.12;
          r.play('Walking', 0.25);
          this.updateLaser(r, player, false);
        }
        break;
      }
      case 'punch': {
        r.facing = turnToward(r.facing, wantFace, 6 * dt);
        const p = r.actionProgress();
        if (!r.punchDone && p > 0.42) {
          r.punchDone = true;
          if (dist < 2.7 && Math.abs(dy) < 1.6) this.cb.onPlayerHit(22, pos.clone().setY(1.4), 'punch');
        }
        if (r.actionDone() || r.stateT > 1.4) {
          r.state = 'chase';
          r.stateT = 0;
          r.attackCd = 0.8;
          r.play('Running', 0.15, 1.1);
        }
        break;
      }
      default:
        break;
    }

    // Movement integration
    if (r.state !== 'spawn') {
      if (moveDir && moveSpeed > 0) {
        this.colliders.avoid(pos, 0.5, _avoid);
        _v.copy(moveDir).multiplyScalar(moveSpeed).addScaledVector(_avoid, moveSpeed * 0.9);
        const grounded = pos.y <= 0.02 || r.vel.y === 0;
        if (grounded) {
          r.vel.x = _v.x;
          r.vel.z = _v.z;
        }
      } else if (pos.y <= 0.02) {
        r.vel.x *= Math.exp(-10 * dt);
        r.vel.z *= Math.exp(-10 * dt);
      }
      r.vel.y -= GRAVITY * dt;
    }
    const prevY = pos.y;
    pos.addScaledVector(r.vel, dt);
    const ground = this.colliders.resolveCapsule(pos, r.vel, 0.5, 2.2, prevY);
    r.grounded = ground !== null;
    if (ground !== null && r.currentClip === 'Jump' && r.state === 'chase' && r.stateT > 0.2) {
      r.play('Running', 0.15, 1.1);
    }
    r.root.rotation.y = r.facing;
    r.updateAnim(dt);
  }

  private updateLaser(r: Robot, player: Player, on: boolean): void {
    let line = this.lasers.get(r);
    if (!on) {
      if (line) line.visible = false;
      return;
    }
    if (!line) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#ff2a2a', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      line.frustumCulled = false;
      this.scene.add(line);
      this.lasers.set(r, line);
    }
    line.visible = true;
    const a = r.cannonMuzzle(new THREE.Vector3());
    const b = player.pos.clone().setY(player.pos.y + 1.2);
    const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, a.x, a.y, a.z);
    attr.setXYZ(1, b.x, b.y, b.z);
    attr.needsUpdate = true;
    (line.material as THREE.LineBasicMaterial).opacity = 0.35 + r.aimCharge * 0.65 * (0.7 + 0.3 * Math.sin(r.stateT * 60));
  }

  private fireProjectile(r: Robot, player: Player): void {
    const from = r.cannonMuzzle(new THREE.Vector3());
    const to = player.pos.clone().setY(player.pos.y + 1.15);
    const dir = to.sub(from).normalize();
    const group = new THREE.Group();
    const core = new THREE.Mesh(this.projGeo, this.projMat);
    const halo = new THREE.Sprite(this.projHaloMat);
    halo.scale.setScalar(1.3);
    const trail = new THREE.Mesh(this.trailGeo, this.trailMat);
    trail.scale.set(1, 1, 2.2);
    group.add(core, halo, trail);
    group.position.copy(from);
    group.lookAt(from.clone().add(dir));
    this.scene.add(group);
    this.projectiles.push({ group, vel: dir.multiplyScalar(30), life: 3, prev: from.clone() });
    this.vfx.burst(from, dir, 10, 5, '#ff6a40', 0.25, 0.6);
    this.vfx.flashLight(from, '#ff3a20', 8, 0.15);
    this.cb.onSound('plasma', from);
  }

  private updateProjectiles(dt: number, player: Player): void {
    const eye = _v.copy(player.pos);
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const p = this.projectiles[i];
      p.prev.copy(p.group.position);
      p.group.position.addScaledVector(p.vel, dt);
      p.life -= dt;
      const pos = p.group.position;
      // Player hit: distance from segment to player capsule axis
      const closestY = Math.max(eye.y + 0.2, Math.min(pos.y, eye.y + PLAYER.height));
      const dx = pos.x - eye.x;
      const dz = pos.z - eye.z;
      const dyy = pos.y - closestY;
      let remove = false;
      if (!player.dashing && dx * dx + dz * dz + dyy * dyy < 0.55 * 0.55) {
        this.cb.onPlayerHit(15, p.prev.clone().sub(p.vel.clone().multiplyScalar(0.5)), 'plasma');
        this.vfx.burst(pos, null, 14, 5, '#ff5a3a', 0.3);
        remove = true;
      } else {
        const step = p.vel.length() * dt;
        const dir = p.vel.clone().normalize();
        const n = new THREE.Vector3();
        const hit = this.colliders.raycast(p.prev, dir, step, n);
        if (hit < step || p.life <= 0) {
          const at = p.prev.clone().addScaledVector(dir, Math.min(hit, step));
          this.vfx.burst(at, n, 18, 6, '#ff6a3a', 0.4, 0.8);
          this.vfx.flashLight(at, '#ff3a20', 4, 0.12);
          this.cb.onSound('plasmaHitWall', at);
          remove = true;
        }
      }
      if (remove) {
        this.scene.remove(p.group);
        this.projectiles.splice(i, 1);
      }
    }
  }

  private separate(): void {
    const rs = this.robots;
    for (let i = 0; i < rs.length; i += 1) {
      const a = rs[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < rs.length; j += 1) {
        const b = rs[j];
        if (!b.alive) continue;
        const dx = b.root.position.x - a.root.position.x;
        const dz = b.root.position.z - a.root.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.1 && d > 1e-4) {
          const push = (1.1 - d) / 2;
          a.root.position.x -= (dx / d) * push;
          a.root.position.z -= (dz / d) * push;
          b.root.position.x += (dx / d) * push;
          b.root.position.z += (dz / d) * push;
        }
      }
    }
  }

  // ---------------- Combat queries ----------------

  raycast(ro: THREE.Vector3, rd: THREE.Vector3, maxDist: number): RobotHit | null {
    let best: RobotHit | null = null;
    for (const r of this.robots) {
      if (!r.alive || r.state === 'spawn' && r.root.position.y > 3) continue;
      const th = raySphere(ro, rd, r.headCenter, r.headRadius);
      if (th >= 0 && th < maxDist && (!best || th < best.dist)) best = { robot: r, dist: th, part: 'head' };
      const tb = rayCapsule(ro, rd, r.bodyA, r.bodyB, r.bodyRadius);
      if (tb >= 0 && tb < maxDist && (!best || tb < best.dist - 0.05)) best = { robot: r, dist: tb, part: 'body' };
      const tl = rayCapsule(ro, rd, r.legA, r.legB, 0.3);
      if (tl >= 0 && tl < maxDist && (!best || tl < best.dist - 0.05)) best = { robot: r, dist: tl, part: 'body' };
    }
    return best;
  }

  /** Best dagger target near the crosshair. */
  findDaggerTarget(camPos: THREE.Vector3, camDir: THREE.Vector3, maxDist = 34, maxAngleDeg = 13): Robot | null {
    let best: Robot | null = null;
    let bestScore = Infinity;
    const cosMax = Math.cos(THREE.MathUtils.degToRad(maxAngleDeg));
    for (const r of this.robots) {
      if (!r.alive || r.state === 'spawn') continue;
      const center = _v.lerpVectors(r.bodyA, r.bodyB, 0.5);
      const to = center.clone().sub(camPos);
      const d = to.length();
      if (d > maxDist) continue;
      to.divideScalar(d);
      const c = to.dot(camDir);
      // Allow a wider cone up close.
      const coneCos = d < 6 ? Math.cos(THREE.MathUtils.degToRad(maxAngleDeg * 2)) : cosMax;
      if (c < coneCos) continue;
      if (!this.los(camPos, center)) continue;
      const score = (1 - c) * 40 + d * 0.02;
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best;
  }

  /** Apply sniper damage. Returns 'headshot' | 'kill' | 'hit'. */
  shoot(hit: RobotHit, dir: THREE.Vector3, point: THREE.Vector3): 'headshot' | 'kill' | 'hit' {
    const r = hit.robot;
    if (hit.part === 'head') {
      this.killHeadshot(r, dir);
      return 'headshot';
    }
    r.hp -= 60;
    r.flash = 1.4;
    this.vfx.burst(point, dir.clone().negate(), 22, 7, '#ffd08a', 0.45, 0.9);
    this.vfx.debrisBurst(point, 3, dir, ['#555', '#888']);
    if (r.hp <= 0) {
      this.killBody(r, dir);
      return 'kill';
    }
    // Stagger + knockback
    r.vel.addScaledVector(dir.clone().setY(0).normalize(), 4);
    r.state = 'stagger';
    r.stateT = 0.05;
    this.updateLaser(r, null as unknown as Player, false);
    return 'hit';
  }

  private markDead(r: Robot): void {
    r.alive = false;
    r.state = 'dead';
    r.removeT = 4.5;
    this.kills += 1;
    this.updateLaser(r, null as unknown as Player, false);
  }

  killHeadshot(r: Robot, dir: THREE.Vector3): void {
    this.markDead(r);
    const neck = r.bone('Neck')!.getWorldPosition(new THREE.Vector3());
    neck.y += 0.08;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(UP, neck);
    const piece = r.makePiece(plane);
    const center = r.headCenter.clone();
    const pv = this.pivotPiece(piece, center, r.headRadius * 0.9);
    pv.vel.copy(dir).multiplyScalar(9).add(new THREE.Vector3(0, 7, 0));
    pv.spin.set((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22);
    r.setHeadVisible(false);
    r.play('Death', 0.05, 1.25);
    r.vel.set(dir.x * 3, 0, dir.z * 3);
    this.fountains.push({ robot: r, bone: 'Neck', t: 1.2, color: '#ffc066' });
    this.vfx.burst(center, dir, 60, 12, '#ffe0a0', 0.7, 1.4, 0.09);
    this.vfx.burst(center, null, 30, 6, '#7fdcff', 0.5, 1, 0.06);
    this.vfx.debrisBurst(center, 8, dir, ['#2b2b2b', '#d0d0d0', '#ff8a3a']);
    this.vfx.smoke(center, 4, 0.8, 1.2, dir.clone().multiplyScalar(2), 0.4, '#555');
    this.vfx.flashLight(center, '#ffb070', 14, 0.25);
    this.vfx.ring(center, dir.clone().negate(), '#ffffff', 2.4, 0.25);
  }

  killDagger(r: Robot, slashDir: THREE.Vector3, right: THREE.Vector3): void {
    this.markDead(r);
    const waistBone = r.bone('Abdomen') ?? r.bone('Hips')!;
    const waist = waistBone.getWorldPosition(new THREE.Vector3());
    waist.y += 0.12;
    const normal = UP.clone().addScaledVector(right, 0.45).normalize();
    const upperPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, waist);
    const piece = r.makePiece(upperPlane);
    const center = r.bodyB.clone().lerp(waist, 0.3);
    const pv = this.pivotPiece(piece, center, 0.6);
    pv.vel.copy(slashDir).multiplyScalar(11).add(new THREE.Vector3(0, 6.5, 0)).addScaledVector(right, -3);
    const axis = new THREE.Vector3().crossVectors(UP, slashDir).normalize();
    pv.spin.copy(axis).multiplyScalar(-14).add(new THREE.Vector3(0, (Math.random() - 0.5) * 8, 0));
    // Lower half: clip away the top and collapse the upper bones.
    const lowerPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.clone().negate(), waist);
    r.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material) {
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.clippingPlanes = [lowerPlane];
        mat.side = THREE.DoubleSide;
        mat.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            '#include <dithering_fragment>\nif (!gl_FrontFacing) gl_FragColor = vec4(3.2, 1.1, 0.25, 1.0);',
          );
        };
        mat.customProgramCacheKey = () => 'molten';
        m.material = mat;
        r.materials.push(mat);
      }
    });
    r.hideUpperBody();
    r.play('Death', 0.05, 1.4);
    r.vel.set(slashDir.x * 2, 0, slashDir.z * 2);
    this.fountains.push({ robot: r, bone: 'Hips', t: 1.0, color: '#ffb050' });
    this.vfx.burst(waist, right, 70, 14, '#bff3ff', 0.6, 1.6, 0.09);
    this.vfx.burst(waist, null, 40, 9, '#ffcf80', 0.7, 1, 0.07);
    this.vfx.debrisBurst(waist, 10, slashDir, ['#2b2b2b', '#d0d0d0', r.kind === 'melee' ? '#e0812f' : '#c6343c']);
    this.vfx.flashLight(waist, '#9fe8ff', 16, 0.3);
    this.vfx.ring(waist, slashDir.clone().negate(), '#9fe8ff', 3.2, 0.3);
  }

  killBody(r: Robot, dir: THREE.Vector3): void {
    this.markDead(r);
    r.play('Death', 0.1, 1.1);
    r.vel.set(dir.x * 5, 0, dir.z * 5);
    const c = r.bodyB.clone().lerp(r.bodyA, 0.4);
    this.vfx.burst(c, dir, 40, 10, '#ffd08a', 0.6, 1.2);
    this.vfx.debrisBurst(c, 6, dir, ['#2b2b2b', '#d0d0d0']);
    this.fountains.push({ robot: r, bone: 'Torso', t: 0.9, color: '#ffae50' });
    // Delayed explosion
    this.delayed.push({ t: 0.9, fn: () => {
      if (!this.robots.includes(r)) return;
      const p = r.bodyA.clone();
      this.vfx.burst(p, null, 80, 13, '#ffb060', 0.8, 1, 0.1);
      this.vfx.debrisBurst(p, 12, null, ['#2b2b2b', '#d0d0d0', r.kind === 'melee' ? '#e0812f' : '#c6343c']);
      this.vfx.smoke(p, 10, 1.6, 2, undefined, 0.5, '#4a4642');
      this.vfx.flashLight(p, '#ff9040', 20, 0.4);
      this.vfx.ring(p.clone().setY(0.1), UP, '#ffb060', 5, 0.45);
      this.cb.onSound('explode', p);
      r.root.visible = false;
      r.removeT = Math.min(r.removeT, 0.1);
    } });
  }

  private pivotPiece(piece: CutPiece, center: THREE.Vector3, radius: number): Pivoted {
    const pivot = new THREE.Object3D();
    pivot.position.copy(center);
    this.scene.add(pivot);
    piece.root.position.sub(center);
    pivot.add(piece.root);
    pivot.updateMatrixWorld(true);
    const inv = piece.root.matrixWorld.clone().invert();
    // Recompute local plane relative to the re-parented root.
    piece.localPlane.copy(piece.plane).applyMatrix4(inv);
    const pv: Pivoted = { ...piece, pivot, radius };
    this.pieces.push(pv);
    return pv;
  }

  private updatePieces(dt: number): void {
    for (let i = this.pieces.length - 1; i >= 0; i -= 1) {
      const p = this.pieces[i];
      p.life -= dt;
      p.vel.y -= GRAVITY * dt;
      p.pivot.position.addScaledVector(p.vel, dt);
      p.pivot.rotation.x += p.spin.x * dt;
      p.pivot.rotation.y += p.spin.y * dt;
      p.pivot.rotation.z += p.spin.z * dt;
      if (p.pivot.position.y < p.radius) {
        p.pivot.position.y = p.radius;
        if (p.vel.y < -2) this.vfx.burst(p.pivot.position.clone().setY(0.1), UP, 8, 3, '#ffc070', 0.3);
        p.vel.y *= -0.35;
        p.vel.x *= 0.6;
        p.vel.z *= 0.6;
        p.spin.multiplyScalar(0.55);
      }
      if (p.life < 0.6) p.pivot.position.y -= dt * 1.2;
      p.pivot.updateMatrixWorld(true);
      p.plane.copy(p.localPlane).applyMatrix4(p.root.matrixWorld);
      // Molten drips
      if (p.life > 3 && Math.random() < 0.6) {
        const at = p.pivot.position.clone();
        this.vfx.spark(at, new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2), new THREE.Color('#ffa040'), 0.5, 0.06);
      }
      if (p.life <= 0) {
        this.scene.remove(p.pivot);
        this.pieces.splice(i, 1);
      }
    }
  }

  private updateFountains(dt: number): void {
    for (let i = this.fountains.length - 1; i >= 0; i -= 1) {
      const f = this.fountains[i];
      f.t -= dt;
      const b = f.robot.bone(f.bone);
      if (b && f.robot.root.visible) {
        const at = b.getWorldPosition(new THREE.Vector3());
        const c = new THREE.Color(f.color);
        const count = Math.ceil(90 * dt * 4);
        for (let k = 0; k < count; k += 1) {
          const v = new THREE.Vector3((Math.random() - 0.5) * 3, 3 + Math.random() * 4, (Math.random() - 0.5) * 3);
          this.vfx.spark(at, v, c, 0.6 + Math.random() * 0.4, 0.06);
        }
        if (Math.random() < 0.15) this.vfx.smoke(at, 1, 0.5, 1.2, undefined, 0.3, '#3a3836');
      }
      if (f.t <= 0) this.fountains.splice(i, 1);
    }
  }

  private removeRobot(r: Robot): void {
    this.scene.remove(r.root);
    const l = this.lasers.get(r);
    if (l) {
      this.scene.remove(l);
      l.geometry.dispose();
      this.lasers.delete(r);
    }
    r.dispose();
  }
}

function turnToward(cur: number, target: number, maxStep: number): number {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return cur + Math.max(-maxStep, Math.min(maxStep, d));
}
