import * as THREE from 'three';

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const saturate = (v: number) => clamp(v, 0, 1);

/** Frame-rate independent exponential approach. `lambda` ~ 1/time-constant. */
export const damp = (a: number, b: number, lambda: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number) => t * t * t;
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeInBack = (t: number) => {
  const c1 = 1.70158;
  return (c1 + 1) * t * t * t - c1 * t * t;
};
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** 0..1 window of t inside [a,b]. */
export const seg = (t: number, a: number, b: number) => saturate((t - a) / (b - a));

/** Critically-damped-ish spring for a scalar (semi-implicit Euler). */
export class Spring {
  value = 0;
  velocity = 0;
  constructor(
    public stiffness = 180,
    public damping = 14,
    public target = 0,
  ) {}
  update(dt: number): number {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i += 1) {
      const f = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += f * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
  impulse(v: number): void {
    this.velocity += v;
  }
  reset(v = 0): void {
    this.value = v;
    this.velocity = 0;
  }
}

/** Vector3 spring built from three scalar springs. */
export class Spring3 {
  readonly x: Spring;
  readonly y: Spring;
  readonly z: Spring;
  readonly out = new THREE.Vector3();
  constructor(stiffness = 180, damping = 14) {
    this.x = new Spring(stiffness, damping);
    this.y = new Spring(stiffness, damping);
    this.z = new Spring(stiffness, damping);
  }
  update(dt: number): THREE.Vector3 {
    this.out.set(this.x.update(dt), this.y.update(dt), this.z.update(dt));
    return this.out;
  }
  impulse(x: number, y: number, z: number): void {
    this.x.impulse(x);
    this.y.impulse(y);
    this.z.impulse(z);
  }
  setTarget(x: number, y: number, z: number): void {
    this.x.target = x;
    this.y.target = y;
    this.z.target = z;
  }
  reset(): void {
    this.x.reset();
    this.y.reset();
    this.z.reset();
  }
}

/** Deterministic value noise in [-1,1]. */
export function noise1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n: number) => {
    const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u);
}

/** Ray vs sphere: returns distance or -1. dir must be normalized. */
export function raySphere(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
): number {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const h = b * b - c;
  if (h < 0) return -1;
  const s = Math.sqrt(h);
  const t = -b - s;
  if (t >= 0) return t;
  const t2 = -b + s;
  return t2 >= 0 ? 0 : -1;
}

const _ba = new THREE.Vector3();
const _oa = new THREE.Vector3();
/** Ray vs capsule (segment a-b, radius r). Returns distance or -1. */
export function rayCapsule(
  ro: THREE.Vector3,
  rd: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  r: number,
): number {
  _ba.subVectors(b, a);
  _oa.subVectors(ro, a);
  const baba = _ba.dot(_ba);
  const bard = _ba.dot(rd);
  const baoa = _ba.dot(_oa);
  const rdoa = rd.dot(_oa);
  const oaoa = _oa.dot(_oa);
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;
  const h = B * B - A * C;
  if (h >= 0) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t >= 0) return t;
    // caps
    const oc = y <= 0 ? _oa : _oa.clone().sub(_ba);
    const bb = rd.dot(oc);
    const cc = oc.dot(oc) - r * r;
    const hh = bb * bb - cc;
    if (hh > 0) {
      const tc = -bb - Math.sqrt(hh);
      if (tc >= 0) return tc;
    }
  }
  return -1;
}

/** Ray vs AABB (slab). Returns distance or -1. */
export function rayBox(ro: THREE.Vector3, rd: THREE.Vector3, box: THREE.Box3): number {
  let tmin = 0;
  let tmax = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const o = ro[axis];
    const d = rd[axis];
    const lo = box.min[axis];
    const hi = box.max[axis];
    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return -1;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}
