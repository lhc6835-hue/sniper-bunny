import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { damp } from '../utils/math';

export type RobotKind = 'melee' | 'ranged';
export type RobotState = 'spawn' | 'chase' | 'aim' | 'punch' | 'stagger' | 'dead';

export const ROBOT_HEIGHT = 2.35;

const TINT: Record<RobotKind, string> = { melee: '#e0812f', ranged: '#c6343c' };

let protoScale = 0;
const DEBUG_HITBOX = new URLSearchParams(location.search).has('hitbox');

/** Material with a molten glowing inside, used for cut pieces. */
function moltenClone(src: THREE.Material, plane: THREE.Plane): THREE.Material {
  const m = (src as THREE.MeshStandardMaterial).clone();
  m.clippingPlanes = [plane];
  m.side = THREE.DoubleSide;
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      '#include <dithering_fragment>\nif (!gl_FrontFacing) gl_FragColor = vec4(3.2, 1.1, 0.25, 1.0);',
    );
  };
  m.customProgramCacheKey = () => 'molten';
  return m;
}

export interface CutPiece {
  root: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  plane: THREE.Plane;
  localPlane: THREE.Plane;
  life: number;
  grounded: boolean;
}

export class Robot {
  readonly root = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private readonly bones = new Map<string, THREE.Bone>();
  readonly materials: THREE.MeshStandardMaterial[] = [];
  cannon: THREE.Group | null = null;
  private cannonGlow: THREE.MeshBasicMaterial | null = null;
  private readonly eyeMats: THREE.MeshStandardMaterial[] = [];

  kind: RobotKind;
  state: RobotState = 'spawn';
  stateT = 0;
  hp = 100;
  speed = 0;
  attackCd = 0;
  flash = 0;
  facing = 0;
  alive = true;
  removeT = 0;
  aimCharge = 0;
  punchDone = false;
  grounded = false;
  noLos = 0;
  readonly vel = new THREE.Vector3();

  // Cached hitboxes (world)
  readonly headCenter = new THREE.Vector3();
  headRadius = 0.56;
  readonly bodyA = new THREE.Vector3();
  readonly bodyB = new THREE.Vector3();
  bodyRadius = 0.38;
  readonly legA = new THREE.Vector3();
  readonly legB = new THREE.Vector3();

  constructor(gltf: GLTF, kind: RobotKind) {
    this.kind = kind;
    this.model = SkeletonUtils.clone(gltf.scene);
    if (!protoScale) {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      protoScale = ROBOT_HEIGHT / (box.max.y - box.min.y);
    }
    this.model.scale.setScalar(protoScale);
    this.root.add(this.model);

    const matCache = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    this.model.traverse((o) => {
      const b = o as THREE.Bone;
      if (b.isBone && !this.bones.has(b.name)) this.bones.set(b.name, b);
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = false;
        m.frustumCulled = false;
        const src = m.material as THREE.MeshStandardMaterial;
        let mat = matCache.get(src);
        if (!mat) {
          mat = src.clone();
          if (src.name === 'Main') mat.color.set(TINT[kind]);
          if (src.name === 'Grey') mat.color.set(kind === 'melee' ? '#d9d4c8' : '#c9c4c4');
          if (src.name === 'Black') {
            mat.emissive.set(kind === 'melee' ? '#ffb43a' : '#ff2a2a');
            mat.emissiveIntensity = 0.0;
            this.eyeMats.push(mat);
          }
          mat.emissive = mat.emissive ?? new THREE.Color();
          matCache.set(src, mat);
          this.materials.push(mat);
        }
        m.material = mat;
      }
    });

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip);
      this.actions.set(clip.name, a);
    }
    for (const n of ['Punch', 'Death', 'Jump', 'No']) {
      const a = this.actions.get(n);
      if (a) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
    }

    if (kind === 'ranged') {
      // Shoulder-mounted plasma cannon.
      const cannon = new THREE.Group();
      const metal = new THREE.MeshStandardMaterial({ color: '#2b2d33', roughness: 0.35, metalness: 0.85 });
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.62, 12), metal);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.z = 0.22;
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.22, 0.34), metal);
      const glowMat = new THREE.MeshBasicMaterial({ color: '#ff3b2f', transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false });
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), glowMat);
      glow.position.z = 0.55;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.02, 6, 16), new THREE.MeshStandardMaterial({ color: '#ff5a3a', emissive: '#ff2a10', emissiveIntensity: 2 }));
      ring.position.z = 0.52;
      cannon.add(barrel, housing, glow, ring);
      cannon.position.set(0.42, 1.72, 0.05);
      this.root.add(cannon);
      this.cannon = cannon;
      this.cannonGlow = glowMat;
    }

    this.play('Jump', 0);
  }

  play(name: string, fade = 0.2, timeScale = 1): void {
    const next = this.actions.get(name);
    if (!next || next === this.current) return;
    next.reset();
    next.timeScale = timeScale;
    next.setEffectiveWeight(1);
    next.play();
    if (this.current && fade > 0) this.current.crossFadeTo(next, fade, false);
    else if (this.current) this.current.stop();
    this.current = next;
  }

  get currentClip(): string {
    return this.current?.getClip().name ?? '';
  }

  actionDone(): boolean {
    const a = this.current;
    if (!a) return true;
    return !a.isRunning() || a.time >= a.getClip().duration - 0.02;
  }

  actionProgress(): number {
    const a = this.current;
    if (!a) return 1;
    return a.time / a.getClip().duration;
  }

  bone(name: string): THREE.Bone | undefined {
    return this.bones.get(name);
  }

  updateAnim(dt: number): void {
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
    this.updateHitboxes();
    // Hit flash & eye glow
    this.flash = damp(this.flash, 0, 14, dt);
    for (const m of this.materials) {
      if (this.eyeMats.includes(m)) continue;
      m.emissive.setRGB(this.flash, this.flash * 0.95, this.flash * 0.9);
      m.emissiveIntensity = 1;
    }
    const eye = this.alive ? (this.state === 'aim' ? 2.5 + this.aimCharge * 4 : 1.4) : 0;
    for (const m of this.eyeMats) m.emissiveIntensity = damp(m.emissiveIntensity, eye, 8, dt);
    if (this.cannonGlow) {
      this.cannonGlow.opacity = this.state === 'aim' ? 0.3 + this.aimCharge * 0.7 : 0.15;
      const s = 1 + (this.state === 'aim' ? this.aimCharge * 1.2 : 0);
      this.cannon!.children[2].scale.setScalar(s);
    }
  }

  private headLocal = -1;
  private debugMeshes: THREE.Mesh[] | null = null;

  private updateHitboxes(): void {
    const head = this.bones.get('Head');
    const neck = this.bones.get('Neck');
    const hips = this.bones.get('Hips');
    const footL = this.bones.get('Foot.L');
    const footR = this.bones.get('Foot.R');
    if (head) {
      if (this.headLocal < 0) {
        const ws = new THREE.Vector3();
        head.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), ws);
        this.headLocal = 0.4 / Math.max(ws.y, 1e-5);
      }
      head.localToWorld(this.headCenter.set(0, this.headLocal, 0));
    }
    if (neck && hips) {
      hips.getWorldPosition(this.bodyA);
      neck.getWorldPosition(this.bodyB);
      this.bodyA.y += 0.05;
    }
    if (DEBUG_HITBOX) this.drawDebug();
    if (hips && footL && footR) {
      hips.getWorldPosition(this.legA);
      const fl = footL.getWorldPosition(new THREE.Vector3());
      const fr = footR.getWorldPosition(new THREE.Vector3());
      this.legB.lerpVectors(fl, fr, 0.5);
      this.legB.y += 0.15;
    }
  }

  private drawDebug(): void {
    if (!this.debugMeshes) {
      const mat = new THREE.MeshBasicMaterial({ color: '#00ff88', wireframe: true });
      const head = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mat);
      const body = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffaa00', wireframe: true }));
      this.debugMeshes = [head, body];
      this.root.parent?.add(head, body);
    }
    const [h, b] = this.debugMeshes;
    h.position.copy(this.headCenter);
    h.scale.setScalar(this.headRadius);
    b.position.lerpVectors(this.bodyA, this.bodyB, 0.5);
    b.scale.set(this.bodyRadius, this.bodyA.distanceTo(this.bodyB) / 2 + this.bodyRadius, this.bodyRadius);
    h.visible = b.visible = this.alive;
  }

  cannonMuzzle(out: THREE.Vector3): THREE.Vector3 {
    if (!this.cannon) return out.copy(this.headCenter);
    return this.cannon.localToWorld(out.set(0, 0, 0.62));
  }

  setHeadVisible(v: boolean): void {
    const head = this.bones.get('Head');
    if (head) head.scale.setScalar(v ? 1 : 0.0001);
  }

  hideUpperBody(): void {
    const b = this.bones.get('Abdomen') ?? this.bones.get('Torso');
    if (b) b.scale.setScalar(0.0001);
    if (this.cannon) this.cannon.visible = false;
  }

  /**
   * Create a frozen clone of the current pose, clipped to keep only the side of
   * `worldPlane` in its normal direction.
   */
  makePiece(worldPlane: THREE.Plane): CutPiece {
    this.root.updateMatrixWorld(true);
    const clone = SkeletonUtils.clone(this.root);
    clone.position.copy(this.root.position);
    clone.quaternion.copy(this.root.quaternion);
    const plane = worldPlane.clone();
    clone.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = moltenClone(m.material as THREE.Material, plane);
        m.frustumCulled = false;
        m.castShadow = true;
      }
    });
    clone.updateMatrixWorld(true);
    const inv = clone.matrixWorld.clone().invert();
    const localPlane = worldPlane.clone().applyMatrix4(inv);
    return { root: clone, vel: new THREE.Vector3(), spin: new THREE.Vector3(), plane, localPlane, life: 4, grounded: false };
  }

  setOpacity(o: number): void {
    for (const m of this.materials) {
      m.transparent = o < 1;
      m.opacity = o;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    for (const m of this.materials) m.dispose();
  }
}
