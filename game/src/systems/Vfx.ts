import * as THREE from 'three';
import { radialTexture } from '../view/models';

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  color: THREE.Color;
  drag: number;
  gravity: number;
  stretch: number;
}

interface Smoke {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  grow: number;
  baseOpacity: number;
}

interface Timed {
  obj: THREE.Mesh;
  life: number;
  maxLife: number;
  update: (k: number, obj: THREE.Mesh) => void;
}

interface Debris {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

const MAX_SPARKS = 900;

/** World-space effects. Uses the *world* (time-scaled) delta so effects slow down with slow motion. */
export class Vfx {
  private readonly sparks: Particle[] = [];
  private readonly sparkGeo = new THREE.BufferGeometry();
  private readonly sparkLines: THREE.LineSegments;
  private readonly glowGeo = new THREE.BufferGeometry();
  private readonly glowPoints: THREE.Points;
  private readonly smokes: Smoke[] = [];
  private readonly smokeMat: THREE.SpriteMaterial;
  private readonly timed: Timed[] = [];
  private readonly debris: Debris[] = [];
  private readonly lights: Array<{ light: THREE.PointLight; life: number; max: number; peak: number }> = [];
  private readonly glowTex = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0.35)', 64);

  constructor(private readonly scene: THREE.Scene) {
    // Spark streaks
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * 2 * 3), 3));
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * 2 * 3), 3));
    this.sparkLines = new THREE.LineSegments(
      this.sparkGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.sparkLines.frustumCulled = false;
    scene.add(this.sparkLines);
    // Glow blobs
    this.glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3));
    this.glowGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS * 3), 3));
    this.glowGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(MAX_SPARKS), 1));
    this.glowPoints = new THREE.Points(
      this.glowGeo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTex: { value: this.glowTex }, uScale: { value: 600 } },
        vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC;
          uniform float uScale;
          void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform sampler2D uTex; varying vec3 vC; void main(){ vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vC * t.a, t.a); }`,
      }),
    );
    this.glowPoints.frustumCulled = false;
    scene.add(this.glowPoints);

    this.smokeMat = new THREE.SpriteMaterial({
      map: radialTexture('rgba(230,225,215,0.9)', 'rgba(200,195,185,0.45)', 64),
      transparent: true,
      depthWrite: false,
      color: '#d8d2c8',
    });
    for (let i = 0; i < 4; i += 1) {
      const light = new THREE.PointLight('#ffb060', 0, 14, 2);
      scene.add(light);
      this.lights.push({ light, life: 0, max: 1, peak: 0 });
    }
  }

  setPointScale(heightPx: number, fovDeg: number): void {
    const mat = this.glowPoints.material as THREE.ShaderMaterial;
    mat.uniforms.uScale.value = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  spark(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color, life: number, size = 0.08, gravity = 12, drag = 1.5, stretch = 0.035): void {
    if (this.sparks.length >= MAX_SPARKS) this.sparks.shift();
    this.sparks.push({ pos: pos.clone(), vel: vel.clone(), life, maxLife: life, size, color: color.clone(), drag, gravity, stretch });
  }

  burst(pos: THREE.Vector3, normal: THREE.Vector3 | null, count: number, speed: number, color: string, life = 0.5, spread = 1, size = 0.07): void {
    const c = new THREE.Color(color);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i += 1) {
      v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      if (normal) v.multiplyScalar(spread).add(normal).normalize();
      v.multiplyScalar(speed * (0.3 + Math.random() * 0.9));
      this.spark(pos, v, c, life * (0.5 + Math.random() * 0.8), size * (0.6 + Math.random()));
    }
  }

  smoke(pos: THREE.Vector3, count: number, size = 0.6, life = 1.4, vel?: THREE.Vector3, opacity = 0.45, color = '#d8d2c8'): void {
    for (let i = 0; i < count; i += 1) {
      const mat = this.smokeMat.clone();
      mat.color.set(color);
      mat.rotation = Math.random() * Math.PI * 2;
      const s = new THREE.Sprite(mat);
      s.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * size * 0.5, (Math.random() - 0.5) * size * 0.3, (Math.random() - 0.5) * size * 0.5));
      s.scale.setScalar(size * (0.6 + Math.random() * 0.6));
      this.scene.add(s);
      const v = vel ? vel.clone() : new THREE.Vector3();
      v.add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.4 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8));
      this.smokes.push({ sprite: s, vel: v, life, maxLife: life, grow: 1.2 + Math.random(), baseOpacity: opacity });
    }
  }

  flashLight(pos: THREE.Vector3, color: string, peak: number, life: number): void {
    const l = this.lights.reduce((a, b) => (a.life < b.life ? a : b));
    l.light.position.copy(pos);
    l.light.color.set(color);
    l.life = life;
    l.max = life;
    l.peak = peak;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color = '#ffe2a8', width = 0.035, life = 0.22): void {
    const len = from.distanceTo(to);
    const geo = new THREE.CylinderGeometry(width, width * 0.4, len, 6, 1, true);
    geo.translate(0, len / 2, 0);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(from);
    mesh.lookAt(to);
    this.scene.add(mesh);
    // Core
    const core = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    core.scale.set(0.35, 0.35, 1);
    mesh.add(core);
    this.timed.push({
      obj: mesh,
      life,
      maxLife: life,
      update: (k, o) => {
        (o.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
        (core.material as THREE.MeshBasicMaterial).opacity = (1 - k);
        o.scale.x = o.scale.y = 1 + k * 2.5;
      },
    });
  }

  ring(pos: THREE.Vector3, normal: THREE.Vector3, color: string, maxRadius: number, life: number, thickness = 0.12): void {
    const geo = new THREE.RingGeometry(0.85, 1, 48);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.lookAt(pos.clone().add(normal));
    this.scene.add(mesh);
    this.timed.push({
      obj: mesh,
      life,
      maxLife: life,
      update: (k, o) => {
        const e = 1 - Math.pow(1 - k, 3);
        o.scale.setScalar(0.2 + e * maxRadius);
        (o.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
        void thickness;
      },
    });
  }

  beam(pos: THREE.Vector3, color: string, life: number, height = 30, radius = 0.6): void {
    const geo = new THREE.CylinderGeometry(radius, radius * 1.4, height, 16, 1, true);
    geo.translate(0, height / 2, 0);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.timed.push({
      obj: mesh,
      life,
      maxLife: life,
      update: (k, o) => {
        const pulse = 0.5 + 0.5 * Math.sin(k * 40);
        (o.material as THREE.MeshBasicMaterial).opacity = (k < 0.85 ? 0.25 + pulse * 0.25 + k * 0.4 : (1 - k) * 4);
        o.scale.x = o.scale.z = 1 - k * 0.7;
      },
    });
  }

  debrisBurst(pos: THREE.Vector3, count: number, dir: THREE.Vector3 | null, colors: string[]): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < count; i += 1) {
      const mat = new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.5, metalness: 0.4 });
      const mesh = new THREE.Mesh(geo, mat);
      const s = 0.06 + Math.random() * 0.14;
      mesh.scale.set(s, s * (0.5 + Math.random()), s * (0.6 + Math.random()));
      mesh.position.copy(pos);
      mesh.castShadow = true;
      this.scene.add(mesh);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.3, Math.random() - 0.5).normalize().multiplyScalar(4 + Math.random() * 7);
      if (dir) v.addScaledVector(dir, 6);
      this.debris.push({ mesh, vel: v, spin: new THREE.Vector3(Math.random() * 20, Math.random() * 20, Math.random() * 20), life: 2.5 + Math.random() });
    }
  }

  update(dt: number): void {
    // Sparks
    const pos = this.sparkGeo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.sparkGeo.getAttribute('color') as THREE.BufferAttribute;
    const gpos = this.glowGeo.getAttribute('position') as THREE.BufferAttribute;
    const gcol = this.glowGeo.getAttribute('color') as THREE.BufferAttribute;
    const gsize = this.glowGeo.getAttribute('size') as THREE.BufferAttribute;
    let n = 0;
    for (let i = this.sparks.length - 1; i >= 0; i -= 1) {
      const p = this.sparks[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.sparks.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.02) {
        p.pos.y = 0.02;
        p.vel.y *= -0.35;
        p.vel.x *= 0.6;
        p.vel.z *= 0.6;
      }
    }
    for (const p of this.sparks) {
      const k = p.life / p.maxLife;
      const r = p.color.r * k * 2;
      const g = p.color.g * k * 2;
      const b = p.color.b * k * 2;
      pos.setXYZ(n * 2, p.pos.x, p.pos.y, p.pos.z);
      pos.setXYZ(n * 2 + 1, p.pos.x - p.vel.x * p.stretch, p.pos.y - p.vel.y * p.stretch, p.pos.z - p.vel.z * p.stretch);
      col.setXYZ(n * 2, r, g, b);
      col.setXYZ(n * 2 + 1, r * 0.2, g * 0.2, b * 0.2);
      gpos.setXYZ(n, p.pos.x, p.pos.y, p.pos.z);
      gcol.setXYZ(n, r * 0.6, g * 0.6, b * 0.6);
      gsize.setX(n, p.size * (0.4 + k));
      n += 1;
    }
    this.sparkGeo.setDrawRange(0, n * 2);
    this.glowGeo.setDrawRange(0, n);
    pos.needsUpdate = col.needsUpdate = gpos.needsUpdate = gcol.needsUpdate = gsize.needsUpdate = true;

    // Smoke
    for (let i = this.smokes.length - 1; i >= 0; i -= 1) {
      const s = this.smokes[i];
      s.life -= dt;
      const k = 1 - s.life / s.maxLife;
      s.sprite.position.addScaledVector(s.vel, dt);
      s.vel.multiplyScalar(Math.exp(-1.5 * dt));
      s.sprite.scale.multiplyScalar(1 + s.grow * dt * 0.6);
      (s.sprite.material as THREE.SpriteMaterial).opacity = s.baseOpacity * (k < 0.1 ? k / 0.1 : 1 - k);
      if (s.life <= 0) {
        this.scene.remove(s.sprite);
        s.sprite.material.dispose();
        this.smokes.splice(i, 1);
      }
    }
    // Timed meshes
    for (let i = this.timed.length - 1; i >= 0; i -= 1) {
      const t = this.timed[i];
      t.life -= dt;
      t.update(Math.min(1, 1 - t.life / t.maxLife), t.obj);
      if (t.life <= 0) {
        this.scene.remove(t.obj);
        t.obj.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.geometry.dispose();
            (m.material as THREE.Material).dispose();
          }
        });
        this.timed.splice(i, 1);
      }
    }
    // Debris
    for (let i = this.debris.length - 1; i >= 0; i -= 1) {
      const d = this.debris[i];
      d.life -= dt;
      d.vel.y -= 18 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      if (d.mesh.position.y < 0.05) {
        d.mesh.position.y = 0.05;
        d.vel.y *= -0.3;
        d.vel.x *= 0.5;
        d.vel.z *= 0.5;
        d.spin.multiplyScalar(0.5);
      }
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.life < 0.5) d.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 4));
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        (d.mesh.material as THREE.Material).dispose();
        this.debris.splice(i, 1);
      }
    }
    for (const l of this.lights) {
      if (l.life > 0) {
        l.life -= dt;
        const k = Math.max(0, l.life / l.max);
        l.light.intensity = l.peak * k * k;
      } else l.light.intensity = 0;
    }
  }
}
