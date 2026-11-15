import * as THREE from 'three';
import { rayBox } from '../utils/math';

export const ARENA_RADIUS = 44;

/** Static world collision: axis-aligned boxes plus a circular arena wall and a flat ground at y=0. */
export class Colliders {
  readonly boxes: THREE.Box3[] = [];

  add(box: THREE.Box3): void {
    this.boxes.push(box);
  }

  addFromObject(obj: THREE.Object3D, shrink = 0.85, maxTop?: number): THREE.Box3 {
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    s.x *= shrink;
    s.z *= shrink;
    box.setFromCenterAndSize(c, s);
    if (maxTop !== undefined) box.max.y = Math.min(box.max.y, maxTop);
    this.boxes.push(box);
    return box;
  }

  /**
   * Resolve a vertical capsule (feet at pos.y). Mutates pos/vel. Returns ground height or null if airborne.
   */
  resolveCapsule(pos: THREE.Vector3, vel: THREE.Vector3, radius: number, height: number, prevY: number): number | null {
    let ground: number | null = null;
    if (pos.y <= 0) {
      pos.y = 0;
      if (vel.y < 0) vel.y = 0;
      ground = 0;
    }
    for (const b of this.boxes) {
      // Quick reject
      if (pos.x < b.min.x - radius || pos.x > b.max.x + radius) continue;
      if (pos.z < b.min.z - radius || pos.z > b.max.z + radius) continue;
      if (pos.y > b.max.y + 0.01 || pos.y + height < b.min.y) continue;

      // Landing on top: we were above the top last frame (or close) and are falling.
      const insideXZ = pos.x > b.min.x - radius * 0.6 && pos.x < b.max.x + radius * 0.6 &&
        pos.z > b.min.z - radius * 0.6 && pos.z < b.max.z + radius * 0.6;
      if (insideXZ && prevY >= b.max.y - 0.35 && vel.y <= 0.01) {
        pos.y = b.max.y;
        vel.y = 0;
        ground = Math.max(ground ?? -Infinity, b.max.y);
        continue;
      }
      // Step-up small ledges
      if (insideXZ && b.max.y - pos.y < 0.45 && b.max.y - pos.y > 0 && vel.y <= 0.01) {
        pos.y = b.max.y;
        vel.y = 0;
        ground = Math.max(ground ?? -Infinity, b.max.y);
        continue;
      }
      // Head bump
      if (insideXZ && prevY + height <= b.min.y + 0.05 && vel.y > 0) {
        pos.y = b.min.y - height;
        vel.y = 0;
        continue;
      }
      // Horizontal push-out: closest point on box (xz) to capsule center.
      const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
      let dx = pos.x - cx;
      let dz = pos.z - cz;
      let d2 = dx * dx + dz * dz;
      if (d2 < radius * radius) {
        if (d2 < 1e-8) {
          // center inside box: push along smallest penetration axis
          const px = Math.min(pos.x - b.min.x, b.max.x - pos.x);
          const pz = Math.min(pos.z - b.min.z, b.max.z - pos.z);
          if (px < pz) {
            dx = pos.x - (b.min.x + b.max.x) / 2 > 0 ? 1 : -1;
            dz = 0;
            pos.x = dx > 0 ? b.max.x + radius : b.min.x - radius;
            vel.x = 0;
          } else {
            dz = pos.z - (b.min.z + b.max.z) / 2 > 0 ? 1 : -1;
            dx = 0;
            pos.z = dz > 0 ? b.max.z + radius : b.min.z - radius;
            vel.z = 0;
          }
          continue;
        }
        const d = Math.sqrt(d2);
        const push = radius - d;
        dx /= d;
        dz /= d;
        pos.x += dx * push;
        pos.z += dz * push;
        const vn = vel.x * dx + vel.z * dz;
        if (vn < 0) {
          vel.x -= vn * dx;
          vel.z -= vn * dz;
        }
        d2 = 0;
      }
    }
    // Arena wall
    const r = Math.hypot(pos.x, pos.z);
    const max = ARENA_RADIUS - radius;
    if (r > max) {
      const nx = pos.x / r;
      const nz = pos.z / r;
      pos.x = nx * max;
      pos.z = nz * max;
      const vn = vel.x * nx + vel.z * nz;
      if (vn > 0) {
        vel.x -= vn * nx;
        vel.z -= vn * nz;
      }
    }
    return ground;
  }

  /** Nearest hit distance along ray against boxes and ground, or Infinity. */
  raycast(ro: THREE.Vector3, rd: THREE.Vector3, maxDist: number, normalOut?: THREE.Vector3): number {
    let best = maxDist;
    let hitBox: THREE.Box3 | null = null;
    for (const b of this.boxes) {
      const t = rayBox(ro, rd, b);
      if (t >= 0 && t < best) {
        best = t;
        hitBox = b;
      }
    }
    let ground = false;
    if (rd.y < -1e-5) {
      const tg = -ro.y / rd.y;
      if (tg >= 0 && tg < best) {
        best = tg;
        ground = true;
        hitBox = null;
      }
    }
    if (normalOut) {
      if (ground) normalOut.set(0, 1, 0);
      else if (hitBox) {
        const p = ro.clone().addScaledVector(rd, best);
        const c = hitBox.getCenter(new THREE.Vector3());
        const s = hitBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
        const d = p.sub(c);
        const ax = Math.abs(d.x / s.x);
        const ay = Math.abs(d.y / s.y);
        const az = Math.abs(d.z / s.z);
        if (ax > ay && ax > az) normalOut.set(Math.sign(d.x), 0, 0);
        else if (ay > az) normalOut.set(0, Math.sign(d.y), 0);
        else normalOut.set(0, 0, Math.sign(d.z));
      }
    }
    return best >= maxDist && !hitBox && !ground ? Infinity : best;
  }

  /** Steering helper for enemies: repulsion vector away from nearby boxes (xz). */
  avoid(pos: THREE.Vector3, radius: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    for (const b of this.boxes) {
      if (b.max.y < 0.5) continue;
      const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d = Math.hypot(dx, dz);
      const range = radius + 2.2;
      if (d < range && d > 1e-4) {
        const w = (range - d) / range;
        out.x += (dx / d) * w;
        out.z += (dz / d) * w;
      }
    }
    return out;
  }

  /** Push a circle (xz) out of boxes — used for enemies. */
  pushCircle(pos: THREE.Vector3, radius: number): void {
    for (const b of this.boxes) {
      if (pos.y > b.max.y || pos.y + 2 < b.min.y) continue;
      const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d = Math.hypot(dx, dz);
      if (d < radius) {
        if (d < 1e-4) {
          pos.x += radius;
          continue;
        }
        pos.x += (dx / d) * (radius - d);
        pos.z += (dz / d) * (radius - d);
      }
    }
    const r = Math.hypot(pos.x, pos.z);
    if (r > ARENA_RADIUS - radius) {
      pos.x *= (ARENA_RADIUS - radius) / r;
      pos.z *= (ARENA_RADIUS - radius) / r;
    }
  }
}
