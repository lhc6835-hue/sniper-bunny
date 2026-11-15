import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { Colliders } from '../world/Colliders';
import { clamp, damp, easeInOutCubic, easeOutCubic } from '../utils/math';

export const PLAYER = {
  radius: 0.4,
  height: 1.7,
  eye: 1.55,
  groundSpeed: 8.2,
  groundAccel: 70,
  friction: 11,
  airAccel: 22,
  airMaxSpeed: 9,
  gravity: 25,
  fallGravityMul: 1.25,
  jumpVel: 8,
  flipJumpVel: 12.8,
  flipForward: 9.5,
  flipDuration: 0.55,
  airFlips: 2,
  maxHp: 100,
};

export type PlayerEvent = 'jump' | 'flip' | 'land' | 'step';

export class Player {
  readonly pos = new THREE.Vector3(0, 0, 14);
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  grounded = true;
  airFlipsLeft = PLAYER.airFlips;
  flipT = -1;
  private flipSide = 1;
  hp = PLAYER.maxHp;
  lastDamageTime = -10;
  moveAmount = 0;
  private stepPhase = 0;
  private roll = 0;
  private bobY = 0;
  landDip = 0;
  // Dash
  dashing = false;
  private dashT = 0;
  private dashDur = 0.2;
  private readonly dashFrom = new THREE.Vector3();
  private readonly dashTo = new THREE.Vector3();
  onEvent: (e: PlayerEvent, data?: number) => void = () => {};

  private readonly wish = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  reset(): void {
    this.pos.set(0, 0, 16);
    this.vel.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = true;
    this.airFlipsLeft = PLAYER.airFlips;
    this.flipT = -1;
    this.hp = PLAYER.maxHp;
    this.dashing = false;
    this.landDip = 0;
  }

  look(dx: number, dy: number, sens: number): void {
    this.yaw -= dx * sens;
    this.pitch = clamp(this.pitch - dy * sens, -1.52, 1.52);
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  startDash(target: THREE.Vector3, duration: number): void {
    this.dashing = true;
    this.dashT = 0;
    this.dashDur = duration;
    this.dashFrom.copy(this.pos);
    this.dashTo.copy(target);
    this.flipT = -1;
  }

  /** Returns dash progress 0..1 or -1 if not dashing. */
  get dashProgress(): number {
    return this.dashing ? this.dashT / this.dashDur : -1;
  }

  update(dt: number, input: Input | null, colliders: Colliders, canAct: boolean): void {
    if (this.dashing) {
      this.dashT += dt;
      const k = easeOutCubic(Math.min(1, this.dashT / this.dashDur));
      const prevY = this.pos.y;
      this.pos.lerpVectors(this.dashFrom, this.dashTo, k);
      this.vel.set(0, 0, 0);
      colliders.resolveCapsule(this.pos, this.vel, PLAYER.radius, PLAYER.height, prevY);
      if (this.dashT >= this.dashDur) {
        this.dashing = false;
        // carry a little momentum + pop up so the player can keep flowing
        this.forward(this.fwd);
        this.vel.copy(this.fwd).multiplyScalar(4);
        this.vel.y = 6;
        this.grounded = false;
        this.airFlipsLeft = Math.max(this.airFlipsLeft, 1);
      }
      return;
    }

    // Input
    this.forward(this.fwd);
    this.right.set(-this.fwd.z, 0, this.fwd.x);
    this.wish.set(0, 0, 0);
    if (input && canAct) {
      if (input.isDown('KeyW')) this.wish.add(this.fwd);
      if (input.isDown('KeyS')) this.wish.sub(this.fwd);
      if (input.isDown('KeyD')) this.wish.add(this.right);
      if (input.isDown('KeyA')) this.wish.sub(this.right);
    }
    const hasWish = this.wish.lengthSq() > 0;
    if (hasWish) this.wish.normalize();

    // Jumps
    if (input && canAct) {
      if (input.wasPressed('Space') && this.grounded) {
        this.vel.y = PLAYER.jumpVel;
        this.grounded = false;
        this.onEvent('jump');
      }
      if (input.wasPressed('ShiftLeft') && (this.grounded || this.airFlipsLeft > 0)) {
        if (!this.grounded) this.airFlipsLeft -= 1;
        this.vel.y = PLAYER.flipJumpVel;
        const dir = hasWish ? this.wish : this.fwd;
        const horiz = Math.hypot(this.vel.x, this.vel.z);
        const along = this.vel.x * dir.x + this.vel.z * dir.z;
        const target = Math.max(PLAYER.flipForward, Math.min(horiz, PLAYER.flipForward * 1.25));
        // Redirect momentum toward the flip direction.
        this.vel.x = dir.x * Math.max(target, along);
        this.vel.z = dir.z * Math.max(target, along);
        this.grounded = false;
        this.flipT = 0;
        this.flipSide = hasWish && this.wish.dot(this.fwd) < -0.5 ? -1 : 1;
        this.onEvent('flip', PLAYER.airFlips - this.airFlipsLeft);
      }
    }

    // Horizontal movement
    const hv = new THREE.Vector2(this.vel.x, this.vel.z);
    if (this.grounded) {
      const speed = hv.length();
      if (speed > 0) {
        const drop = speed * PLAYER.friction * dt;
        hv.multiplyScalar(Math.max(0, speed - drop) / speed);
      }
      if (hasWish) {
        const cur = hv.x * this.wish.x + hv.y * this.wish.z;
        const add = clamp(PLAYER.groundSpeed - cur, 0, PLAYER.groundAccel * dt);
        hv.x += this.wish.x * add;
        hv.y += this.wish.z * add;
      }
    } else if (hasWish) {
      const cur = hv.x * this.wish.x + hv.y * this.wish.z;
      const add = clamp(PLAYER.airMaxSpeed - cur, 0, PLAYER.airAccel * dt);
      hv.x += this.wish.x * add;
      hv.y += this.wish.z * add;
    }
    this.vel.x = hv.x;
    this.vel.z = hv.y;

    // Gravity
    const g = this.vel.y < 0 ? PLAYER.gravity * PLAYER.fallGravityMul : PLAYER.gravity;
    this.vel.y -= g * dt;

    const prevY = this.pos.y;
    const fallSpeed = -this.vel.y;
    this.pos.addScaledVector(this.vel, dt);
    const ground = colliders.resolveCapsule(this.pos, this.vel, PLAYER.radius, PLAYER.height, prevY);
    const wasGrounded = this.grounded;
    this.grounded = ground !== null && this.vel.y <= 0.01;
    if (this.grounded && !wasGrounded) {
      this.airFlipsLeft = PLAYER.airFlips;
      const impact = clamp((fallSpeed - 4) / 14, 0, 1);
      this.landDip = 0.06 + impact * 0.18;
      this.flipT = -1;
      this.onEvent('land', impact);
    }
    // Flip progress
    if (this.flipT >= 0) {
      this.flipT += dt / PLAYER.flipDuration;
      if (this.flipT >= 1) this.flipT = -1;
    }

    // Footsteps & bob
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.moveAmount = clamp(speed / PLAYER.groundSpeed, 0, 1);
    if (this.grounded && speed > 1) {
      const prev = this.stepPhase;
      this.stepPhase += dt * speed * 0.9;
      if (Math.floor(prev / Math.PI) !== Math.floor(this.stepPhase / Math.PI)) this.onEvent('step');
    }
    this.bobY = this.grounded ? Math.abs(Math.sin(this.stepPhase)) * 0.045 * this.moveAmount : damp(this.bobY, 0, 10, dt);
    const strafe = this.vel.x * this.right.x + this.vel.z * this.right.z;
    this.roll = damp(this.roll, -strafe * 0.0035, 8, dt);
    this.landDip = damp(this.landDip, 0, 9, dt);
  }

  /** Writes camera transform. `extraPitch` lets the game add recoil kick. */
  applyCamera(camera: THREE.PerspectiveCamera, extraPitch: number, shake: THREE.Vector3): void {
    camera.position.set(this.pos.x, this.pos.y + PLAYER.eye - this.bobY - this.landDip, this.pos.z);
    let flipPitch = 0;
    let flipRoll = 0;
    if (this.flipT >= 0) {
      const e = easeInOutCubic(this.flipT);
      flipPitch = -this.flipSide * e * Math.PI * 2;
      flipRoll = Math.sin(this.flipT * Math.PI) * 0.12;
    }
    camera.rotation.set(this.pitch + extraPitch + flipPitch + shake.x, this.yaw + shake.y, this.roll + flipRoll + shake.z, 'YXZ');
  }
}
