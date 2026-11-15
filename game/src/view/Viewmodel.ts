import * as THREE from 'three';
import {
  createArm, createCasingGeometry, createDagger, createSniper, flashTexture, MAT,
  type ArmModel, type DaggerModel, type SniperModel,
} from './models';
import {
  clamp, damp, easeInCubic, easeInOutCubic, easeOutBack, easeOutCubic, easeOutExpo, lerp, seg, Spring, Spring3,
} from '../utils/math';

export type VmEvent =
  | 'boltOpen' | 'casing' | 'boltClose' | 'boltLock' | 'magOut' | 'magIn' | 'magSlap'
  | 'daggerDraw' | 'daggerSheath' | 'sniperReady';

export interface VmContext {
  adsHeld: boolean;
  moveAmount: number; // 0..1
  grounded: boolean;
  mouseDX: number;
  mouseDY: number;
  flipT: number; // -1 when not flipping, else 0..1
  charge: number; // 0..1 dagger charge
  elapsed: number;
}

type Mode = 'sniper' | 'daggerIn' | 'dagger' | 'lunge' | 'strike' | 'daggerOut';

const HIP_POS = new THREE.Vector3(0.2, -0.2, -0.6);
const HIP_ROT = new THREE.Euler(0.03, 0.02, 0.0);
const BOLT_TIME = 0.62;
const RELOAD_TIME = 1.75;
const MAG_SIZE = 5;

const RIGHT_SHOULDER = new THREE.Vector3(0.46, -0.6, 0.3);
const LEFT_SHOULDER = new THREE.Vector3(-0.42, -0.72, 0.05);

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();

interface Casing {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(64, 1, 0.01, 10);
  private readonly rig = new THREE.Group();
  private readonly sniper: SniperModel;
  private readonly dagger: DaggerModel;
  private readonly rightArm: ArmModel;
  private readonly leftArm: ArmModel;
  private readonly muzzleLight = new THREE.PointLight('#ffb35c', 0, 3, 2);
  private readonly flash: THREE.Group;
  private readonly casings: Casing[] = [];
  private readonly trail: THREE.Mesh;
  private readonly trailPts: Array<{ a: THREE.Vector3; b: THREE.Vector3; age: number }> = [];

  // Springs
  private readonly recoilPos = new Spring3(240, 17);
  private readonly recoilRot = new Spring3(280, 15);
  private readonly swayRot = new Spring3(120, 13);
  private readonly swayPos = new Spring3(110, 14);
  private readonly landSpring = new Spring(160, 11);

  ads = 0;
  ammo = MAG_SIZE;
  private chambered = true;
  private boltT = -1;
  private boltDelay = 0;
  private reloadT = -1;
  private flashT = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private airAmount = 0;
  private mode: Mode = 'sniper';
  private modeT = 0;
  private strikeHasTarget = false;
  private readonly firedEvents = new Set<string>();
  private kick = 0;
  onEvent: (e: VmEvent) => void = () => {};

  constructor(envMap: THREE.Texture | null) {
    this.scene.environment = envMap;
    this.scene.environmentIntensity = 0.45;
    this.scene.add(this.camera);
    const key = new THREE.DirectionalLight('#ffe2bf', 1.7);
    key.position.set(-0.6, 1, 0.4);
    const fill = new THREE.HemisphereLight('#cfe3ff', '#59603a', 0.55);
    const rim = new THREE.DirectionalLight('#9fc6ff', 0.9);
    rim.position.set(1, 0.3, -1);
    this.scene.add(key, fill, rim, this.muzzleLight);

    this.sniper = createSniper();
    this.dagger = createDagger();
    this.rightArm = createArm(1);
    this.leftArm = createArm(-1);
    this.scene.add(this.rig);
    this.rig.add(this.sniper.root);
    this.scene.add(this.rightArm.root, this.leftArm.root);
    // Dagger lives in the right paw: blade (+Y) out the thumb side (-X of paw)
    this.dagger.root.rotation.set(0, 0, Math.PI / 2);
    this.dagger.root.position.set(0.0, -0.05, -0.012);
    this.dagger.root.visible = false;
    this.rightArm.paw.add(this.dagger.root);

    // Muzzle flash
    this.flash = new THREE.Group();
    const ftex = flashTexture();
    const fmat = new THREE.MeshBasicMaterial({ map: ftex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), fmat);
    const side1 = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.22), fmat);
    side1.rotation.y = Math.PI / 2;
    side1.position.z = -0.3;
    const side2 = side1.clone();
    side2.rotation.z = Math.PI / 2;
    this.flash.add(front, side1, side2);
    this.flash.visible = false;
    this.sniper.muzzle.add(this.flash);

    // Casings pool
    const cg = createCasingGeometry();
    for (let i = 0; i < 6; i += 1) {
      const mesh = new THREE.Mesh(cg, MAT.brass);
      mesh.visible = false;
      this.scene.add(mesh);
      this.casings.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 });
    }

    // Slash trail ribbon
    const tgeo = new THREE.BufferGeometry();
    const max = 24;
    tgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 2 * 3), 3));
    tgeo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(max * 2), 1));
    const idx: number[] = [];
    for (let i = 0; i < max - 1; i += 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    tgeo.setIndex(idx);
    const tmat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vA; void main(){ vec3 c = mix(vec3(0.35,0.85,1.0), vec3(1.0), vA*vA); gl_FragColor = vec4(c * vA * 2.2, vA); }',
    });
    this.trail = new THREE.Mesh(tgeo, tmat);
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);
  }

  // ---------------- Public API ----------------

  get isDaggerMode(): boolean {
    return this.mode !== 'sniper';
  }

  get busy(): boolean {
    return this.boltT >= 0 || this.reloadT >= 0 || this.mode !== 'sniper';
  }

  canFire(): boolean {
    return this.mode === 'sniper' && this.chambered && this.ammo > 0 && this.boltT < 0 && this.reloadT < 0;
  }

  get reloading(): boolean {
    return this.reloadT >= 0;
  }

  fire(): void {
    this.ammo -= 1;
    this.chambered = false;
    const adsScale = lerp(1, 0.45, this.ads);
    this.recoilPos.impulse(0, 0.55 * adsScale, 3.2 * adsScale);
    this.recoilRot.impulse(8.5 * adsScale, (Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 5);
    this.flashT = 0.05;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
    this.kick = 1;
    if (this.ammo > 0) {
      this.boltDelay = 0.11;
      this.boltT = 0;
      this.firedEvents.clear();
    }
  }

  reload(): boolean {
    if (this.mode !== 'sniper' || this.reloadT >= 0 || this.boltT >= 0 || this.ammo >= MAG_SIZE) return false;
    this.reloadT = 0;
    this.firedEvents.clear();
    return true;
  }

  startDagger(): boolean {
    if (this.mode !== 'sniper') return false;
    // Abort any bolt/reload cleanly.
    if (this.boltT >= 0) {
      this.boltT = -1;
      this.chambered = this.ammo > 0;
    }
    if (this.reloadT >= 0) {
      this.reloadT = -1;
      this.ammo = MAG_SIZE;
      this.chambered = true;
      this.sniper.mag.position.set(0, -0.012, -0.17);
    }
    this.mode = 'daggerIn';
    this.modeT = 0;
    this.onEvent('daggerDraw');
    return true;
  }

  /** F released: anticipation pose until `slash()` is called. */
  release(hasTarget: boolean): void {
    if (this.mode !== 'dagger' && this.mode !== 'daggerIn') return;
    this.mode = 'lunge';
    this.modeT = 0;
    this.strikeHasTarget = hasTarget;
  }

  slash(): void {
    this.mode = 'strike';
    this.modeT = 0;
    this.trailPts.length = 0;
  }

  land(impact: number): void {
    this.landSpring.impulse(-impact * 1.4);
    this.recoilRot.impulse(-impact * 3, 0, 0);
  }

  /** Muzzle position in view space (for tracer start). */
  getMuzzleView(out: THREE.Vector3): THREE.Vector3 {
    this.sniper.muzzle.updateWorldMatrix(true, false);
    return this.sniper.muzzle.getWorldPosition(out);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Whether the scope overlay should be visible. */
  get scoped(): boolean {
    return this.ads > 0.9 && this.mode === 'sniper' && this.reloadT < 0;
  }

  // ---------------- Update ----------------

  update(dt: number, ctx: VmContext): void {
    const canAds = this.mode === 'sniper' && this.reloadT < 0;
    this.ads = damp(this.ads, ctx.adsHeld && canAds ? 1 : 0, ctx.adsHeld && canAds ? 16 : 14, dt);
    if (this.ads > 0.995) this.ads = 1;

    // Sway from mouse
    const swayK = lerp(1, 0.15, this.ads);
    this.swayRot.impulse(clamp(-ctx.mouseDY * 0.012, -1.4, 1.4) * swayK, clamp(-ctx.mouseDX * 0.012, -1.4, 1.4) * swayK, clamp(-ctx.mouseDX * 0.02, -2, 2) * swayK);
    this.swayPos.impulse(clamp(ctx.mouseDX * 0.0009, -0.1, 0.1) * swayK, clamp(-ctx.mouseDY * 0.0009, -0.1, 0.1) * swayK, 0);
    this.swayRot.update(dt);
    this.swayPos.update(dt);
    this.recoilPos.update(dt);
    this.recoilRot.update(dt);
    this.landSpring.update(dt);

    // Bob
    this.bobAmount = damp(this.bobAmount, ctx.grounded ? ctx.moveAmount : 0, 10, dt);
    this.bobPhase += dt * (6 + 5 * ctx.moveAmount);
    this.airAmount = damp(this.airAmount, ctx.grounded ? 0 : 1, 8, dt);

    this.kick = damp(this.kick, 0, 12, dt);
    this.updateBolt(dt);
    this.updateReload(dt);
    this.modeT += dt;
    this.updateModeTransitions();

    this.poseGun(ctx);
    this.poseArms(ctx);
    if (this.scoped) {
      this.rightArm.root.visible = false;
      this.leftArm.root.visible = false;
    }
    this.updateFx(dt, ctx);
  }

  private updateBolt(dt: number): void {
    if (this.boltT < 0) {
      this.sniper.bolt.rotation.z = 0;
      this.sniper.boltSlide.position.z = -0.02;
      return;
    }
    if (this.boltDelay > 0) {
      this.boltDelay -= dt;
      return;
    }
    this.boltT += dt / BOLT_TIME;
    const t = this.boltT;
    const lift = easeOutCubic(seg(t, 0.15, 0.27)) - easeInOutCubic(seg(t, 0.62, 0.72));
    const slide = easeOutCubic(seg(t, 0.27, 0.42)) - easeInCubic(seg(t, 0.47, 0.6));
    this.sniper.bolt.rotation.z = lift * 1.25;
    this.sniper.boltSlide.position.z = -0.02 + slide * 0.11;
    this.fireOnce('boltOpen', t >= 0.24);
    if (this.fireOnce('casing', t >= 0.4)) this.ejectCasing();
    if (this.fireOnce('boltClose', t >= 0.6)) {
      this.recoilPos.impulse(0, -0.08, -0.35);
      this.recoilRot.impulse(-1.2, 0, 0);
    }
    this.fireOnce('boltLock', t >= 0.71);
    if (t >= 1) {
      this.boltT = -1;
      this.chambered = true;
    }
  }

  private updateReload(dt: number): void {
    if (this.reloadT < 0) return;
    this.reloadT += dt / RELOAD_TIME;
    const t = this.reloadT;
    const mag = this.sniper.mag;
    // Mag drop and insert
    const out = easeInCubic(seg(t, 0.2, 0.32));
    const away = seg(t, 0.3, 0.45);
    const back = easeOutCubic(seg(t, 0.45, 0.62));
    const insert = easeOutBack(seg(t, 0.62, 0.7));
    let y = -0.012;
    if (t < 0.45) y -= out * 0.12 + away * 0.6;
    else if (t < 0.62) y -= 0.72 - back * 0.6;
    else y -= 0.12 * (1 - insert);
    mag.position.y = y;
    mag.rotation.x = t > 0.3 && t < 0.62 ? -0.4 * Math.sin(seg(t, 0.3, 0.62) * Math.PI) : 0;
    this.fireOnce('magOut', t >= 0.24);
    if (this.fireOnce('magIn', t >= 0.68)) {
      this.recoilPos.impulse(0, 0.35, 0);
      this.recoilRot.impulse(2.5, 0, -2);
    }
    this.fireOnce('magSlap', t >= 0.76);
    if (t >= 1) {
      this.reloadT = -1;
      mag.position.y = -0.012;
      mag.rotation.x = 0;
      this.ammo = MAG_SIZE;
      if (!this.chambered) {
        this.boltT = 0;
        this.boltDelay = 0.02;
        this.firedEvents.clear();
      }
    }
  }

  private updateModeTransitions(): void {
    if (this.mode === 'daggerIn' && this.modeT > 0.2) {
      this.mode = 'dagger';
      this.modeT = 0;
    } else if (this.mode === 'lunge' && this.modeT > 0.6) {
      // Safety: game never called slash
      this.slash();
    } else if (this.mode === 'strike' && this.modeT > 0.42) {
      this.mode = 'daggerOut';
      this.modeT = 0;
      this.onEvent('daggerSheath');
    } else if (this.mode === 'daggerOut' && this.modeT > 0.32) {
      this.mode = 'sniper';
      this.modeT = 0;
      this.recoilRot.impulse(-3, 0, 2);
      this.onEvent('sniperReady');
    }
  }

  private fireOnce(name: string, cond: boolean): boolean {
    if (cond && !this.firedEvents.has(name)) {
      this.firedEvents.add(name);
      if (name !== 'casing') this.onEvent(name as VmEvent);
      return true;
    }
    return false;
  }

  // ---------------- Posing ----------------

  private poseGun(ctx: VmContext): void {
    const g = this.sniper.root;
    const a = easeInOutCubic(this.ads);
    const adsPos = _v.set(0, -this.sniper.scopeHeight, -0.2);
    g.position.lerpVectors(HIP_POS, adsPos, a);
    let rx = lerp(HIP_ROT.x, 0, a);
    let ry = lerp(HIP_ROT.y, 0, a);
    let rz = 0;

    // Breathing + bob
    const bob = this.bobAmount * (1 - a * 0.85);
    g.position.x += Math.sin(this.bobPhase) * 0.014 * bob;
    g.position.y += -Math.abs(Math.cos(this.bobPhase)) * 0.016 * bob + Math.sin(ctx.elapsed * 1.7) * 0.003 * (1 - a);
    rz += Math.sin(this.bobPhase) * 0.02 * bob;
    // Airborne lift
    g.position.y += this.airAmount * 0.012 * (1 - a);
    rx += this.airAmount * 0.05 * (1 - a);
    // Landing
    g.position.y += this.landSpring.value * 0.05;

    // Sway
    rx += this.swayRot.x.value * 0.05;
    ry += this.swayRot.y.value * 0.05;
    rz += this.swayRot.z.value * 0.05;
    g.position.x += this.swayPos.x.value;
    g.position.y += this.swayPos.y.value;

    // Recoil
    g.position.x += this.recoilPos.x.value * 0.02;
    g.position.y += this.recoilPos.y.value * 0.02;
    g.position.z += this.recoilPos.z.value * 0.03;
    rx += this.recoilRot.x.value * 0.03;
    ry += this.recoilRot.y.value * 0.03;
    rz += this.recoilRot.z.value * 0.03;

    // Bolt cycle: tilt the rifle toward the paw
    if (this.boltT >= 0 && this.boltDelay <= 0) {
      const t = this.boltT;
      const env = easeOutCubic(seg(t, 0, 0.16)) * (1 - easeInOutCubic(seg(t, 0.72, 1)));
      const adsK = lerp(1, 0.35, a);
      // Punchy accents on bolt open/close
      const yank = Math.sin(seg(t, 0.27, 0.42) * Math.PI) * 0.6 + Math.sin(seg(t, 0.47, 0.62) * Math.PI) * -0.4;
      rz += (0.55 + yank * 0.1) * env * adsK;
      ry += 0.16 * env * adsK;
      rx += (0.1 + yank * 0.05) * env * adsK;
      g.position.x -= 0.05 * env * adsK;
      g.position.y += 0.03 * env * adsK;
      g.position.z += yank * 0.02 * adsK;
    }
    // Reload: big tilt
    if (this.reloadT >= 0) {
      const t = this.reloadT;
      const env = easeOutBack(seg(t, 0, 0.14)) * (1 - easeInOutCubic(seg(t, 0.78, 0.95)));
      rz -= 0.65 * env;
      rx += 0.28 * env;
      ry -= 0.12 * env;
      g.position.x -= 0.06 * env;
      g.position.y += 0.05 * env;
      g.position.z += 0.04 * env;
    }
    // Flip tuck
    if (ctx.flipT >= 0) {
      const s = Math.sin(ctx.flipT * Math.PI);
      g.position.y -= s * 0.1;
      g.position.z += s * 0.08;
      rx -= s * 0.55;
      rz += s * 0.25;
    }
    // Dagger mode: drop sniper offscreen
    const drop = this.sniperDropAmount();
    if (drop > 0) {
      g.position.y -= drop * 0.55;
      g.position.x += drop * 0.12;
      rx -= drop * 0.9;
      rz -= drop * 0.4;
    }
    g.rotation.set(rx, ry, rz, 'YXZ');
    g.visible = drop < 0.98;
    this.rig.visible = !this.scoped;
    if (this.scoped) {
      this.rightArm.root.visible = false;
      this.leftArm.root.visible = false;
    }
  }

  private sniperDropAmount(): number {
    switch (this.mode) {
      case 'sniper':
        return 0;
      case 'daggerIn':
        return easeInCubic(seg(this.modeT, 0, 0.12));
      case 'daggerOut':
        return 1 - easeOutCubic(seg(this.modeT, 0.08, 0.32));
      default:
        return 1;
    }
  }

  /** Place a paw at `pos` with its wrist pointing at `shoulder` and palm facing `palm`. */
  private placeArm(arm: ArmModel, pos: THREE.Vector3, palm: THREE.Vector3, shoulder: THREE.Vector3, visible = true): void {
    arm.root.visible = visible;
    if (!visible) return;
    _y.subVectors(shoulder, pos).normalize();
    _z.copy(palm).multiplyScalar(-1);
    _z.addScaledVector(_y, -_z.dot(_y)).normalize();
    _x.crossVectors(_y, _z).normalize();
    _m.makeBasis(_x, _y, _z);
    arm.paw.position.copy(pos);
    arm.paw.quaternion.setFromRotationMatrix(_m);
    // Sleeve from wrist to shoulder
    const wrist = _v2.copy(pos).addScaledVector(_y, 0.035);
    arm.sleeve.position.copy(wrist);
    arm.sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _y);
    arm.sleeve.scale.set(1, wrist.distanceTo(shoulder) + 0.2, 1);
  }

  private poseArms(ctx: VmContext): void {
    const g = this.sniper.root;
    g.updateMatrixWorld(true);
    const gunQ = _q.copy(g.quaternion);
    const drop = this.sniperDropAmount();

    if (this.mode === 'sniper' || this.mode === 'daggerIn' || this.mode === 'daggerOut') {
      if (drop > 0.5 && this.mode !== 'sniper') {
        this.poseDaggerArms(ctx);
        return;
      }
      this.dagger.root.visible = false;
      // Right paw: grip, or bolt knob during cycle
      const grip = this.sniper.gripSocket.getWorldPosition(new THREE.Vector3());
      let rightPos = grip;
      if (this.boltT >= 0 && this.boltDelay <= 0) {
        const t = this.boltT;
        const w = easeInOutCubic(seg(t, 0, 0.15)) * (1 - easeInOutCubic(seg(t, 0.72, 0.95)));
        const knob = this.sniper.boltKnobSocket.getWorldPosition(new THREE.Vector3());
        knob.add(new THREE.Vector3(0.03, -0.01, 0.01).applyQuaternion(gunQ));
        rightPos = grip.lerp(knob, w);
      }
      const rightPalm = new THREE.Vector3(-1, 0.2, 0).applyQuaternion(gunQ).normalize();
      this.placeArm(this.rightArm, rightPos, rightPalm, RIGHT_SHOULDER);
      this.rightArm.fingers.rotation.x = -0.6;

      // Left paw: forend, or magazine during reload
      let leftPos = this.sniper.foreSocket.getWorldPosition(new THREE.Vector3());
      let leftPalm = new THREE.Vector3(1, 0.6, 0).applyQuaternion(gunQ).normalize();
      let leftVisible = true;
      if (this.reloadT >= 0) {
        const t = this.reloadT;
        const magPos = this.sniper.magSocket.getWorldPosition(new THREE.Vector3());
        const toMag = easeInOutCubic(seg(t, 0.1, 0.22));
        const fromMag = easeInOutCubic(seg(t, 0.72, 0.84));
        const w = toMag * (1 - fromMag);
        leftPos = leftPos.lerp(magPos, w);
        leftPalm = leftPalm.lerp(new THREE.Vector3(1, 0, 0).applyQuaternion(gunQ), w).normalize();
        if (t > 0.38 && t < 0.52) leftVisible = false;
      }
      this.placeArm(this.leftArm, leftPos, leftPalm, LEFT_SHOULDER, leftVisible && drop < 0.6);
      this.leftArm.fingers.rotation.x = -0.4;
      if (drop > 0) {
        this.rightArm.root.visible = drop < 0.7;
      }
      return;
    }
    this.poseDaggerArms(ctx);
  }

  private poseDaggerArms(ctx: VmContext): void {
    this.dagger.root.visible = true;
    // Rise from below when entering
    let rise = 1;
    if (this.mode === 'daggerIn') rise = easeOutBack(seg(this.modeT, 0.08, 0.2));
    if (this.mode === 'daggerOut') rise = 1 - easeInCubic(seg(this.modeT, 0, 0.14));

    const charge = this.mode === 'dagger' || this.mode === 'daggerIn' ? ctx.charge : 1;
    const shake = charge * 0.004;
    const sx = (Math.random() - 0.5) * shake;
    const sy = (Math.random() - 0.5) * shake;

    // Key poses (paw position + euler)
    const chargePos = new THREE.Vector3(0.2 + charge * 0.03, -0.16 + charge * 0.04, -0.36 + charge * 0.06);
    const chargeRot = new THREE.Euler(0.25 + charge * 0.3, -Math.PI / 2 + 0.55, -0.5 - charge * 0.25, 'YXZ');
    const lungePos = new THREE.Vector3(0.32, -0.1, -0.22);
    const lungeRot = new THREE.Euler(0.85, -Math.PI / 2 + 0.4, -0.8, 'YXZ');
    const endPos = new THREE.Vector3(-0.2, -0.36, -0.62);
    const endRot = new THREE.Euler(-0.3, -Math.PI / 2 - 0.5, 1.25, 'YXZ');

    const pos = new THREE.Vector3();
    const rot = new THREE.Euler(0, 0, 0, 'YXZ');
    let leftPos = new THREE.Vector3(-0.17, -0.2, -0.46);
    let leftPalm = new THREE.Vector3(0.1, 0.1, -1).normalize();

    if (this.mode === 'daggerIn' || this.mode === 'dagger') {
      pos.copy(chargePos);
      rot.copy(chargeRot);
    } else if (this.mode === 'lunge') {
      const k = easeOutCubic(seg(this.modeT, 0, 0.07));
      pos.lerpVectors(chargePos, lungePos, k);
      rot.set(lerp(chargeRot.x, lungeRot.x, k), lerp(chargeRot.y, lungeRot.y, k), lerp(chargeRot.z, lungeRot.z, k));
      leftPos = leftPos.lerp(new THREE.Vector3(-0.14, -0.2, -0.62), k);
    } else if (this.mode === 'strike') {
      const k = easeOutExpo(seg(this.modeT, 0, 0.09));
      const rec = easeInOutCubic(seg(this.modeT, 0.18, 0.42));
      pos.lerpVectors(lungePos, endPos, k);
      // Arc: swing passes through center, bulging forward
      pos.z -= Math.sin(k * Math.PI) * 0.12;
      pos.y += Math.sin(k * Math.PI) * 0.04;
      rot.set(lerp(lungeRot.x, endRot.x, k), lerp(lungeRot.y, endRot.y, k), lerp(lungeRot.z, endRot.z, k));
      // Recover toward low ready
      pos.lerp(new THREE.Vector3(0.1, -0.45, -0.4), rec);
      leftPos = new THREE.Vector3(-0.36, -0.44, -0.5);
      leftPalm = new THREE.Vector3(1, 0, 0);
    } else {
      pos.set(0.1, -0.45, -0.4);
      rot.copy(endRot);
    }
    pos.x += sx;
    pos.y += sy - (1 - rise) * 0.5;
    leftPos.y -= (1 - rise) * 0.5;
    pos.add(this.swayPos.out);

    this.rightArm.root.visible = true;
    this.rightArm.paw.position.copy(pos);
    this.rightArm.paw.rotation.copy(rot);
    this.rightArm.fingers.rotation.x = -1.1;
    // Sleeve from wrist to shoulder
    const up = new THREE.Vector3(0, 1, 0).applyEuler(rot);
    const wrist = pos.clone().addScaledVector(up, 0.035);
    const dir = new THREE.Vector3().subVectors(RIGHT_SHOULDER, wrist);
    const len = dir.length();
    dir.normalize();
    this.rightArm.sleeve.position.copy(wrist);
    this.rightArm.sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.rightArm.sleeve.scale.set(1, len + 0.2, 1);

    this.placeArm(this.leftArm, leftPos, leftPalm, LEFT_SHOULDER, this.mode !== 'daggerOut');
    this.leftArm.fingers.rotation.x = this.mode === 'strike' ? -0.8 : 0.1;

    // Blade glow
    const glow = this.mode === 'strike' ? 1 - seg(this.modeT, 0.1, 0.4) : this.mode === 'lunge' ? 1 : charge;
    MAT.bladeGlow.opacity = glow * (0.55 + Math.sin(ctx.elapsed * 40) * 0.12 * charge);
  }

  // ---------------- FX ----------------

  private ejectCasing(): void {
    const c = this.casings.find((k) => k.life <= 0) ?? this.casings[0];
    this.sniper.ejectPort.getWorldPosition(c.mesh.position);
    const q = this.sniper.root.quaternion;
    c.vel.set(1.4 + Math.random() * 0.4, 1.2 + Math.random() * 0.5, 0.3).applyQuaternion(q);
    c.spin.set(Math.random() * 20, 25 + Math.random() * 10, Math.random() * 15);
    c.mesh.quaternion.copy(q);
    c.mesh.rotateX(Math.PI / 2);
    c.mesh.visible = true;
    c.life = 1.0;
    this.onEvent('casing');
  }

  private updateFx(dt: number, ctx: VmContext): void {
    // Muzzle flash
    this.flashT -= dt;
    const flashing = this.flashT > 0;
    this.flash.visible = flashing && this.ads < 0.5;
    this.muzzleLight.intensity = flashing ? 6 : damp(this.muzzleLight.intensity, 0, 30, dt);
    if (flashing) this.getMuzzleView(this.muzzleLight.position);

    for (const c of this.casings) {
      if (c.life <= 0) continue;
      c.life -= dt;
      c.vel.y -= 7 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      if (c.life <= 0) c.mesh.visible = false;
    }

    // Slash trail
    const tgeo = this.trail.geometry;
    const posAttr = tgeo.getAttribute('position') as THREE.BufferAttribute;
    const alphaAttr = tgeo.getAttribute('alpha') as THREE.BufferAttribute;
    if (this.mode === 'strike' && this.modeT < 0.2) {
      const base = this.dagger.root.localToWorld(new THREE.Vector3(0, 0.03, 0));
      const tip = this.dagger.tip.getWorldPosition(new THREE.Vector3());
      // Extend the tip for a longer swoosh
      tip.sub(base).multiplyScalar(1.8).add(base);
      this.trailPts.unshift({ a: base, b: tip, age: 0 });
      if (this.trailPts.length > 24) this.trailPts.pop();
    }
    for (const p of this.trailPts) p.age += dt;
    while (this.trailPts.length && this.trailPts[this.trailPts.length - 1].age > 0.16) this.trailPts.pop();
    const n = this.trailPts.length;
    for (let i = 0; i < 24; i += 1) {
      const p = this.trailPts[Math.min(i, n - 1)];
      const alpha = i < n && p ? (1 - i / Math.max(n, 2)) * (1 - p.age / 0.16) : 0;
      if (p) {
        posAttr.setXYZ(i * 2, p.a.x, p.a.y, p.a.z);
        posAttr.setXYZ(i * 2 + 1, p.b.x, p.b.y, p.b.z);
      }
      alphaAttr.setX(i * 2, alpha * 0.15);
      alphaAttr.setX(i * 2 + 1, alpha);
    }
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    this.trail.visible = n > 1;
    void ctx;
    void this.strikeHasTarget;
  }
}
