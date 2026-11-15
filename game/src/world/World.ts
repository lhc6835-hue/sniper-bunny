import * as THREE from 'three';
import type { Assets, PropName } from './Assets';
import { ARENA_RADIUS, Colliders } from './Colliders';
import { createSeededRandom } from '../utils/random';

export const SUN_DIR = new THREE.Vector3(-0.55, 0.42, -0.72).normalize();
const HORIZON = new THREE.Color('#f3c99a');
const FOG = new THREE.Color('#d9b99a');

export class World {
  readonly group = new THREE.Group();
  readonly colliders = new Colliders();
  readonly sun: THREE.DirectionalLight;
  private readonly grassMat: THREE.ShaderMaterial;
  private readonly crystalMats: THREE.MeshStandardMaterial[] = [];
  /** Spawn points around the arena (xz). */
  readonly spawnPoints: THREE.Vector3[] = [];

  constructor(scene: THREE.Scene, private readonly assets: Assets) {
    scene.background = HORIZON.clone();
    scene.fog = new THREE.Fog(FOG, 28, 190);

    const hemi = new THREE.HemisphereLight('#cfe3ff', '#5b6b3a', 1.15);
    scene.add(hemi);
    this.sun = new THREE.DirectionalLight('#ffd7a3', 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -38;
    sc.right = 38;
    sc.top = 38;
    sc.bottom = -38;
    sc.near = 1;
    sc.far = 160;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    const rim = new THREE.DirectionalLight('#9ec8ff', 0.6);
    rim.position.set(30, 20, 40);
    scene.add(rim);

    scene.add(this.group);
    this.group.add(this.createSky());
    this.group.add(this.createGround());
    this.group.add(this.createMountains());
    this.grassMat = this.createGrassMaterial();
    this.group.add(this.createGrass());
    this.buildProps();

    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2 + 0.2;
      this.spawnPoints.push(new THREE.Vector3(Math.cos(a) * 33, 0, Math.sin(a) * 33));
    }
  }

  update(elapsed: number, playerPos: THREE.Vector3): void {
    this.grassMat.uniforms.uTime.value = elapsed;
    this.grassMat.uniforms.uPlayer.value.copy(playerPos);
    // Shadow camera follows the player (snapped to texel grid to avoid shimmering).
    const snap = (76 / 2048) * 2;
    const tx = Math.round(playerPos.x / snap) * snap;
    const tz = Math.round(playerPos.z / snap) * snap;
    this.sun.target.position.set(tx, 0, tz);
    this.sun.position.set(tx, 0, tz).addScaledVector(SUN_DIR, 80);
    const pulse = 1.6 + Math.sin(elapsed * 2.2) * 0.6;
    for (const m of this.crystalMats) m.emissiveIntensity = pulse;
  }

  private createSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(400, 48, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSun: { value: SUN_DIR.clone() },
        uZenith: { value: new THREE.Color('#4f86c6') },
        uHorizon: { value: HORIZON.clone() },
        uGround: { value: new THREE.Color('#b99b7b') },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSun; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround;
        varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
        float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=0.5; } return v; }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
          col = mix(col, uGround, smoothstep(0.0, -0.15, h));
          float sd = max(dot(d, uSun), 0.0);
          col += vec3(1.0, 0.75, 0.45) * pow(sd, 8.0) * 0.55;
          col += vec3(1.0, 0.9, 0.7) * pow(sd, 900.0) * 18.0;
          // clouds
          if (h > 0.02) {
            vec2 uv = d.xz / (h + 0.12) * 1.6;
            float c = smoothstep(0.52, 0.85, fbm(uv + vec2(3.0, 1.0)));
            vec3 cloudCol = mix(vec3(1.0, 0.86, 0.74), vec3(1.0, 0.97, 0.92), pow(sd, 3.0));
            col = mix(col, cloudCol, c * 0.75 * smoothstep(0.02, 0.25, h));
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    return sky;
  }

  private createGround(): THREE.Mesh {
    const size = 512;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#6e8f3d';
    ctx.fillRect(0, 0, size, size);
    const rng = createSeededRandom(7);
    for (let i = 0; i < 9000; i += 1) {
      const x = rng() * size;
      const y = rng() * size;
      const r = 1 + rng() * 5;
      const g = 110 + rng() * 60;
      ctx.fillStyle = `rgba(${70 + rng() * 50},${g},${40 + rng() * 25},${0.25 + rng() * 0.35})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 260; i += 1) {
      ctx.fillStyle = `rgba(${120 + rng() * 40},${100 + rng() * 30},${60},${0.18})`;
      ctx.beginPath();
      ctx.arc(rng() * size, rng() * size, 8 + rng() * 22, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(40, 40);
    tex.anisotropy = 8;
    const geo = new THREE.CircleGeometry(260, 64);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, color: '#c9d9a4' });
    // Darken toward the crash-site crater and add subtle large-scale variation.
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float r = length(vWPos.xz);
          float scorch = 1.0 - smoothstep(4.0, 11.0, r);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16,0.13,0.1), scorch * 0.75);
          float big = sin(vWPos.x*0.07)*sin(vWPos.z*0.06);
          diffuseColor.rgb *= 0.92 + big*0.08;
          float edge = smoothstep(${(ARENA_RADIUS - 2).toFixed(1)}, ${(ARENA_RADIUS + 10).toFixed(1)}, r);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.45,0.42,0.3), edge*0.5);`,
        );
    };
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    return ground;
  }

  /** Procedural jagged low-poly rock wall ring with mossy tops. */
  private createCliffRing(radius: number, baseH: number, varH: number, varR: number, low: string, mid: string, top: string, seed: number): THREE.Mesh {
    const segs = 140;
    const levels = [0, 0.3, 0.62, 0.86, 1];
    const rng = createSeededRandom(seed);
    const ph = [rng() * 10, rng() * 10, rng() * 10, rng() * 10];
    const n = (a: number, f: number, p: number) => Math.sin(a * f + p);
    const pos: number[] = [];
    const col: number[] = [];
    const cLow = new THREE.Color(low);
    const cMid = new THREE.Color(mid);
    const cTop = new THREE.Color(top);
    const grid: THREE.Vector3[][] = [];
    for (let i = 0; i <= segs; i += 1) {
      const a = (i / segs) * Math.PI * 2;
      const hn = 0.5 + 0.25 * n(a, 3, ph[0]) + 0.15 * n(a, 7, ph[1]) + 0.1 * n(a, 17, ph[2]);
      const H = baseH + varH * hn + (i % segs === 0 ? 0 : (rng() - 0.5) * 2.5);
      const rBase = radius + varR * (0.5 + 0.5 * n(a, 5, ph[3]));
      const col_: THREE.Vector3[] = [];
      for (let k = 0; k < levels.length; k += 1) {
        const l = levels[k];
        const jitter = i % segs === 0 ? 0 : (rng() - 0.5) * 1.6;
        const r = rBase + l * l * 5 + jitter - (k === levels.length - 1 ? 1.5 : 0);
        const y = k === 0 ? -1 : H * l + (rng() - 0.5) * 0.8;
        col_.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
      }
      grid.push(col_);
    }
    // close loop exactly
    grid[segs] = grid[0];
    const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ka: number) => {
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      const t = levels[ka];
      const base = t < 0.5 ? cLow.clone().lerp(cMid, t * 2) : cMid.clone().lerp(cTop, (t - 0.5) * 2 > 0.7 ? 1 : 0);
      const shade = 0.85 + rng() * 0.25;
      for (let q = 0; q < 3; q += 1) col.push(base.r * shade, base.g * shade, base.b * shade);
    };
    for (let i = 0; i < segs; i += 1) {
      for (let k = 0; k < levels.length - 1; k += 1) {
        const a = grid[i][k];
        const b = grid[i + 1][k];
        const c = grid[i][k + 1];
        const d = grid[i + 1][k + 1];
        pushTri(a, c, b, k);
        pushTri(b, c, d, k + 1 === levels.length - 1 ? k + 1 : k);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  }

  private createMountains(): THREE.Group {
    const g = new THREE.Group();
    const rng = createSeededRandom(21);
    const mat = new THREE.MeshStandardMaterial({ color: '#8a8aa8', roughness: 1, flatShading: true });
    const snow = new THREE.MeshStandardMaterial({ color: '#f1ece6', roughness: 1, flatShading: true });
    const geo = new THREE.ConeGeometry(1, 1, 6, 3);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const y = pos.getY(i);
      if (y < 0.49) {
        pos.setX(i, pos.getX(i) * (0.85 + Math.sin(i * 12.3) * 0.15));
        pos.setZ(i, pos.getZ(i) * (0.85 + Math.cos(i * 7.1) * 0.15));
      }
    }
    geo.computeVertexNormals();
    const capGeo = new THREE.ConeGeometry(0.28, 0.28, 6, 1);
    const n = 34;
    const body = new THREE.InstancedMesh(geo, mat, n);
    const caps = new THREE.InstancedMesh(capGeo, snow, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.15;
      const r = 170 + rng() * 60;
      const h = 40 + rng() * 55;
      const w = 45 + rng() * 40;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI);
      m.compose(new THREE.Vector3(Math.cos(a) * r, h / 2 - 4, Math.sin(a) * r), q, new THREE.Vector3(w, h, w));
      body.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(Math.cos(a) * r, h - 4 - h * 0.14 + 0.5, Math.sin(a) * r), q, new THREE.Vector3(w, h, w));
      caps.setMatrixAt(i, m);
    }
    g.add(body, caps);
    return g;
  }

  private createGrassMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      fog: true,
      side: THREE.DoubleSide,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uPlayer: { value: new THREE.Vector3() },
          uBase: { value: new THREE.Color('#3f5f22') },
          uTip: { value: new THREE.Color('#c7d36a') },
          uSun: { value: SUN_DIR.clone() },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        uniform float uTime; uniform vec3 uPlayer;
        attribute vec3 aOffset; attribute vec2 aParams;
        varying float vH; varying float vShade;
        void main() {
          vec3 p = position;
          float h = p.y;
          vH = h;
          float ang = aParams.x;
          float s = aParams.y;
          mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
          p.xz = rot * p.xz;
          p *= s;
          vec3 world = p + aOffset;
          float wind = sin(uTime * 1.7 + aOffset.x * 0.35 + aOffset.z * 0.22) * 0.5 + sin(uTime*3.1 + aOffset.z*0.9)*0.2;
          world.x += wind * h * h * 0.35 * s;
          world.z += wind * h * h * 0.18 * s;
          vec2 away = world.xz - uPlayer.xz;
          float d = length(away);
          float push = (1.0 - smoothstep(0.0, 1.4, d)) * step(uPlayer.y, 0.6);
          world.xz += normalize(away + 1e-4) * push * h * 0.7;
          world.y -= push * h * 0.3;
          vShade = 0.75 + 0.25 * sin(aOffset.x * 1.3 + aOffset.z * 2.1);
          vec4 mvPosition = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uBase; uniform vec3 uTip;
        varying float vH; varying float vShade;
        void main() {
          vec3 col = mix(uBase, uTip, smoothstep(0.0, 1.0, vH)) * vShade;
          col *= 1.15;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
  }

  private createGrass(): THREE.Mesh {
    // One blade: 2 tris tapered quad + tip.
    const blade = new THREE.BufferGeometry();
    const w = 0.06;
    const verts = new Float32Array([
      -w, 0, 0, w, 0, 0, -w * 0.6, 0.5, 0,
      w, 0, 0, w * 0.6, 0.5, 0, -w * 0.6, 0.5, 0,
      -w * 0.6, 0.5, 0, w * 0.6, 0.5, 0, 0, 1, 0,
    ]);
    blade.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    const count = 26000;
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = null;
    geo.setAttribute('position', blade.getAttribute('position'));
    const offsets = new Float32Array(count * 3);
    const params = new Float32Array(count * 2);
    const rng = createSeededRandom(3);
    for (let i = 0; i < count; i += 1) {
      const r = Math.sqrt(rng()) * (ARENA_RADIUS + 6);
      const a = rng() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x, z) < 8 + rng() * 3) {
        offsets[i * 3 + 1] = -10; // hide inside crater
      }
      offsets[i * 3] = x;
      offsets[i * 3 + 2] = z;
      params[i * 2] = rng() * Math.PI;
      params[i * 2 + 1] = 0.35 + rng() * 0.55;
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 2));
    geo.instanceCount = count;
    const mesh = new THREE.Mesh(geo, this.grassMat);
    mesh.frustumCulled = false;
    return mesh;
  }

  private place(name: PropName, height: number, x: number, z: number, rotY: number, collide: boolean | 'trunk' = true, y = 0, byWidth = false): THREE.Group {
    const p = this.assets.prop(name, height, byWidth);
    p.position.set(x, y, z);
    p.rotation.y = rotY;
    this.group.add(p);
    if (collide === 'trunk') {
      const b = new THREE.Box3(new THREE.Vector3(x - 0.45, y, z - 0.45), new THREE.Vector3(x + 0.45, y + height * 0.55, z + 0.45));
      this.colliders.add(b);
    } else if (collide) {
      this.colliders.addFromObject(p, 0.82);
    }
    return p;
  }

  private scatterInstanced(name: PropName, height: number, count: number, rmin: number, rmax: number, seed: number, scaleVar = 0.4): void {
    const parts = this.assets.parts(name, height);
    const rng = createSeededRandom(seed);
    const meshes = parts.map((p) => {
      const im = new THREE.InstancedMesh(p.geometry, p.material, count);
      im.castShadow = height > 1;
      im.receiveShadow = true;
      return im;
    });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i += 1) {
      let x = 0;
      let z = 0;
      for (let tries = 0; tries < 8; tries += 1) {
        const r = rmin + Math.sqrt(rng()) * (rmax - rmin);
        const a = rng() * Math.PI * 2;
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        if (Math.hypot(x, z) > 10) break;
      }
      q.setFromAxisAngle(v.set(0, 1, 0), rng() * Math.PI * 2);
      s.setScalar(1 - scaleVar / 2 + rng() * scaleVar);
      m.compose(v.set(x, 0, z), q, s);
      for (const im of meshes) im.setMatrixAt(i, m);
    }
    for (const im of meshes) this.group.add(im);
  }

  private buildProps(): void {
    const rng = createSeededRandom(42);
    const R = ARENA_RADIUS;

    this.group.add(this.createCliffRing(R + 7, 7, 10, 3, '#6f6a62', '#8d877c', '#8b9a55', 5));
    this.group.add(this.createCliffRing(R + 34, 16, 18, 6, '#5e6470', '#7b8290', '#7d8f5a', 9));

    // Backdrop forest
    const trees: PropName[] = ['tree_pineTallA_detailed', 'tree_oak', 'tree_pineRoundA', 'tree_fat', 'tree_detailed', 'tree_default'];
    for (let i = 0; i < 70; i += 1) {
      const a = rng() * Math.PI * 2;
      const r = R + 12 + rng() * 40;
      this.place(trees[i % trees.length], 11 + rng() * 9, Math.cos(a) * r, Math.sin(a) * r, rng() * 6, false);
    }

    // Crash site (center)
    this.place('craterLarge', 20, 0, 0, 0.3, false, -0.05, true);
    this.place('hangar_roundA', 6, 7.5, -5.5, 0.6);
    this.place('machine_generatorLarge', 3.2, -6, 4.5, -0.4);
    this.place('satelliteDish_large', 7, -8.5, -7.5, 2.4);
    this.place('structure_detailed', 4.5, 9.5, 7, -0.9);
    this.place('barrels', 1.4, 4.2, 4.6, 0.2);
    this.place('barrels', 1.4, -3.5, -4.8, 1.2);
    this.place('machine_barrelLarge', 2.4, -1.5, 8.5, 0.8);
    this.place('meteor_detailed', 3.5, 0.5, 0.5, 0.5);
    this.place('turret_double', 2.6, 12.5, -1.5, -1.4);
    this.place('platform_large', 7, -12, 1.5, 0.3, true, 0, true);
    this.place('supports_high', 5, -12.5, 9, 0);
    for (let i = 0; i < 5; i += 1) {
      const a = 0.4 + i * 1.3;
      const crystal = this.place('rock_crystalsLargeA', 2.2 + rng() * 1.5, Math.cos(a) * (6 + rng() * 3), Math.sin(a) * (6 + rng() * 3), rng() * 6, false);
      crystal.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        if (mat.color && mat.color.b > mat.color.r) {
          mat.emissive = new THREE.Color('#5fd8ff');
          mat.emissiveIntensity = 1.6;
          this.crystalMats.push(mat);
        }
        mesh.material = mat;
      });
    }

    // Cover rocks & sniper perches in two rings
    const rocks: PropName[] = ['stone_largeA', 'rock_largeB', 'stone_largeB', 'rock_largeD', 'stone_largeC', 'rock_largeE'];
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2 + 0.25 + rng() * 0.2;
      const r = 17 + rng() * 6;
      this.place(rocks[i % rocks.length], 3.2 + rng() * 2.2, Math.cos(a) * r, Math.sin(a) * r, rng() * 6, true, 0, true);
    }
    const tall: PropName[] = ['stone_tallA', 'rock_tallB', 'stone_tallE', 'stone_tallB'];
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2 + 0.6;
      const r = 29 + rng() * 5;
      this.place(tall[i % tall.length], 3.6 + rng() * 1.6, Math.cos(a) * r, Math.sin(a) * r, rng() * 6, true, 0, true);
    }
    // Ancient ruins
    for (let i = 0; i < 7; i += 1) {
      const a = -0.9 + i * 0.32;
      const r = 25;
      this.place('statue_columnDamaged', 5 + rng() * 2.5, Math.cos(a) * r, Math.sin(a) * r, rng() * 6);
    }
    this.place('statue_ring', 6, Math.cos(2.8) * 24, Math.sin(2.8) * 24, 1.2, false);
    // Arena trees (trunk colliders)
    for (let i = 0; i < 12; i += 1) {
      const a = rng() * Math.PI * 2;
      const r = 14 + rng() * 26;
      this.place(trees[(i + 2) % trees.length], 8 + rng() * 4, Math.cos(a) * r, Math.sin(a) * r, rng() * 6, 'trunk');
    }
    this.place('log_large', 1.0, 15, 12, 0.8);
    this.place('log_large', 1.0, -20, -9, 2.1);
    this.place('stump_roundDetailed', 0.9, -16, 15, 0);

    // Decoration (instanced, no collision)
    this.scatterInstanced('grass_large', 0.9, 160, 9, R + 4, 11);
    this.scatterInstanced('plant_bushLarge', 1.4, 40, 14, R + 2, 12);
    this.scatterInstanced('plant_bushDetailed', 1.0, 40, 12, R + 2, 13);
    this.scatterInstanced('flower_redA', 0.5, 90, 10, R, 14);
    this.scatterInstanced('flower_yellowA', 0.5, 90, 10, R, 15);
    this.scatterInstanced('flower_purpleA', 0.5, 90, 10, R, 16);
    this.scatterInstanced('mushroom_redGroup', 0.5, 30, 12, R, 17);
    this.scatterInstanced('crop_carrot', 0.55, 36, 12, R, 18);
  }
}
