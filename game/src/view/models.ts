import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- Material kit ----------
export const MAT = {
  cerakote: new THREE.MeshStandardMaterial({ color: '#56603d', roughness: 0.62, metalness: 0.15 }),
  cerakoteDark: new THREE.MeshStandardMaterial({ color: '#3a4229', roughness: 0.7, metalness: 0.1 }),
  steel: new THREE.MeshStandardMaterial({ color: '#2a2c30', roughness: 0.32, metalness: 0.9 }),
  steelLight: new THREE.MeshStandardMaterial({ color: '#8c9096', roughness: 0.22, metalness: 1 }),
  polymer: new THREE.MeshStandardMaterial({ color: '#1d1f1c', roughness: 0.8, metalness: 0.05 }),
  rubber: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.95 }),
  tan: new THREE.MeshStandardMaterial({ color: '#9c8458', roughness: 0.85 }),
  brass: new THREE.MeshStandardMaterial({ color: '#c9973f', roughness: 0.28, metalness: 1 }),
  lens: new THREE.MeshPhysicalMaterial({
    color: '#0b1020', roughness: 0.05, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02,
    emissive: new THREE.Color('#3b2a7a'), emissiveIntensity: 0.35,
  }),
  blade: new THREE.MeshStandardMaterial({ color: '#d7dde3', roughness: 0.16, metalness: 1 }),
  bladeGlow: new THREE.MeshBasicMaterial({
    color: '#66e3ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  }),
  wrap: new THREE.MeshStandardMaterial({ color: '#2b2522', roughness: 0.95 }),
  fur: new THREE.MeshStandardMaterial({ color: '#d6ccbf', roughness: 1 }),
  furShade: new THREE.MeshStandardMaterial({ color: '#d2c6b8', roughness: 1 }),
  pad: new THREE.MeshStandardMaterial({ color: '#f2a3b0', roughness: 0.7 }),
  sleeve: new THREE.MeshStandardMaterial({ color: '#4a5634', roughness: 0.92 }),
  strap: new THREE.MeshStandardMaterial({ color: '#2b2f22', roughness: 0.9 }),
};

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, name?: string): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  if (name) m.name = name;
  return m;
}

function cylZ(rTop: number, rBot: number, len: number, seg = 18): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg);
  g.rotateX(Math.PI / 2);
  return g;
}

function rbox(w: number, h: number, d: number, r = 0.008): THREE.BufferGeometry {
  return new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2.1, h / 2.1, d / 2.1));
}

// ---------- Sniper ----------
export interface SniperModel {
  root: THREE.Group;
  bolt: THREE.Group;
  boltSlide: THREE.Group;
  mag: THREE.Group;
  muzzle: THREE.Object3D;
  ejectPort: THREE.Object3D;
  gripSocket: THREE.Object3D;
  foreSocket: THREE.Object3D;
  boltKnobSocket: THREE.Object3D;
  magSocket: THREE.Object3D;
  /** Distance of the scope axis above gun origin. */
  scopeHeight: number;
}

export function createSniper(): SniperModel {
  const root = new THREE.Group();
  root.name = 'sniper';

  // Receiver
  const receiver = mesh(rbox(0.066, 0.074, 0.36, 0.012), MAT.cerakote, 'receiver');
  receiver.position.set(0, 0.03, -0.13);
  root.add(receiver);
  // Ejection port recess (right side)
  const port = mesh(new THREE.BoxGeometry(0.004, 0.03, 0.09), MAT.polymer);
  port.position.set(0.034, 0.042, -0.07);
  root.add(port);
  // Picatinny rail with ribs
  const rail = mesh(new THREE.BoxGeometry(0.03, 0.01, 0.34), MAT.steel);
  rail.position.set(0, 0.072, -0.14);
  root.add(rail);
  const ribGeo = new THREE.BoxGeometry(0.034, 0.008, 0.008);
  const ribs = new THREE.InstancedMesh(ribGeo, MAT.steel, 20);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 20; i += 1) {
    ribs.setMatrixAt(i, m4.makeTranslation(0, 0.08, -0.3 + i * 0.016));
  }
  root.add(ribs);

  // Handguard / forend with M-LOK slots
  const forend = mesh(rbox(0.078, 0.07, 0.38, 0.014), MAT.cerakote, 'forend');
  forend.position.set(0, 0.018, -0.5);
  root.add(forend);
  const slotGeo = new THREE.BoxGeometry(0.004, 0.012, 0.035);
  const slots = new THREE.InstancedMesh(slotGeo, MAT.polymer, 10);
  for (let i = 0; i < 5; i += 1) {
    slots.setMatrixAt(i, m4.makeTranslation(0.04, 0.02, -0.36 - i * 0.06));
    slots.setMatrixAt(i + 5, m4.makeTranslation(-0.04, 0.02, -0.36 - i * 0.06));
  }
  root.add(slots);
  const forendTop = mesh(new THREE.BoxGeometry(0.03, 0.008, 0.36), MAT.steel);
  forendTop.position.set(0, 0.056, -0.5);
  root.add(forendTop);

  // Barrel: heavy fluted barrel + muzzle brake
  const barrel = mesh(cylZ(0.0145, 0.018, 0.6), MAT.steel, 'barrel');
  barrel.position.set(0, 0.03, -0.92);
  root.add(barrel);
  const fluteGeo = new THREE.BoxGeometry(0.003, 0.003, 0.3);
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    const f = mesh(fluteGeo, MAT.polymer);
    f.position.set(Math.cos(a) * 0.0158, 0.03 + Math.sin(a) * 0.0158, -0.85);
    root.add(f);
  }
  const brake = mesh(rbox(0.04, 0.034, 0.075, 0.006), MAT.steel, 'brake');
  brake.position.set(0, 0.03, -1.255);
  root.add(brake);
  const brakePortGeo = new THREE.BoxGeometry(0.042, 0.02, 0.01);
  for (let i = 0; i < 3; i += 1) {
    const bp = mesh(brakePortGeo, MAT.polymer);
    bp.position.set(0, 0.03, -1.235 - i * 0.02);
    root.add(bp);
  }
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.03, -1.3);
  root.add(muzzle);

  // Scope
  const scopeH = 0.118;
  const tube = mesh(cylZ(0.019, 0.019, 0.26, 24), MAT.steel, 'scopeTube');
  tube.position.set(0, scopeH, -0.15);
  root.add(tube);
  const objective = mesh(cylZ(0.033, 0.021, 0.1, 28), MAT.steel);
  objective.position.set(0, scopeH, -0.32);
  root.add(objective);
  const objRing = mesh(cylZ(0.035, 0.035, 0.02, 28), MAT.polymer);
  objRing.position.set(0, scopeH, -0.37);
  root.add(objRing);
  const lensFront = mesh(new THREE.CircleGeometry(0.03, 28), MAT.lens);
  lensFront.position.set(0, scopeH, -0.381);
  lensFront.rotation.y = Math.PI;
  root.add(lensFront);
  const eyepiece = mesh(cylZ(0.022, 0.028, 0.08, 24), MAT.steel);
  eyepiece.position.set(0, scopeH, 0.02);
  root.add(eyepiece);
  const eyeCup = mesh(cylZ(0.029, 0.029, 0.02, 24), MAT.rubber);
  eyeCup.position.set(0, scopeH, 0.065);
  root.add(eyeCup);
  const lensRear = mesh(new THREE.CircleGeometry(0.024, 24), MAT.lens);
  lensRear.position.set(0, scopeH, 0.076);
  root.add(lensRear);
  const turretTop = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 16), MAT.steel);
  turretTop.position.set(0, scopeH + 0.028, -0.14);
  root.add(turretTop);
  const turretCap = mesh(new THREE.CylinderGeometry(0.0145, 0.0145, 0.008, 16), MAT.brass);
  turretCap.position.set(0, scopeH + 0.045, -0.14);
  root.add(turretCap);
  const turretSide = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.026, 16), MAT.steel);
  turretSide.rotation.z = Math.PI / 2;
  turretSide.position.set(0.028, scopeH, -0.14);
  root.add(turretSide);
  const ringGeo = new THREE.TorusGeometry(0.021, 0.006, 8, 24);
  for (const z of [-0.06, -0.23]) {
    const ring = mesh(ringGeo, MAT.polymer);
    ring.position.set(0, scopeH, z);
    root.add(ring);
    const base = mesh(rbox(0.032, 0.03, 0.02, 0.004), MAT.polymer);
    base.position.set(0, 0.088, z);
    root.add(base);
  }

  // Bolt: pivot group rotates about the bore axis (z), slide translates back.
  const boltSlide = new THREE.Group();
  boltSlide.position.set(0, 0.045, -0.02);
  root.add(boltSlide);
  const bolt = new THREE.Group();
  boltSlide.add(bolt);
  const boltBody = mesh(cylZ(0.013, 0.013, 0.12), MAT.steelLight, 'boltBody');
  boltBody.position.set(0, 0, -0.03);
  bolt.add(boltBody);
  const boltShroud = mesh(cylZ(0.016, 0.014, 0.04), MAT.steel);
  boltShroud.position.set(0, 0, 0.045);
  bolt.add(boltShroud);
  const handle = mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.075, 10), MAT.steelLight, 'boltHandle');
  handle.rotation.z = -Math.PI / 2 + 0.35;
  handle.position.set(0.036, -0.012, 0.02);
  bolt.add(handle);
  const knob = mesh(new THREE.SphereGeometry(0.018, 16, 12), MAT.polymer, 'boltKnob');
  knob.scale.set(1, 1, 1.25);
  knob.position.set(0.07, -0.026, 0.022);
  bolt.add(knob);
  const boltKnobSocket = new THREE.Object3D();
  boltKnobSocket.position.copy(knob.position);
  bolt.add(boltKnobSocket);

  // Magazine
  const mag = new THREE.Group();
  mag.position.set(0, -0.012, -0.17);
  root.add(mag);
  const magBody = mesh(rbox(0.048, 0.085, 0.085, 0.008), MAT.polymer, 'mag');
  magBody.position.set(0, -0.04, 0);
  mag.add(magBody);
  const magPlate = mesh(rbox(0.052, 0.012, 0.09, 0.004), MAT.steel);
  magPlate.position.set(0, -0.085, 0);
  mag.add(magPlate);
  const roundTip = mesh(new THREE.CylinderGeometry(0.004, 0.007, 0.02, 8), MAT.brass);
  roundTip.rotation.x = -Math.PI / 2;
  roundTip.position.set(0, 0.004, -0.03);
  mag.add(roundTip);
  const magSocket = new THREE.Object3D();
  magSocket.position.set(-0.03, -0.05, 0);
  mag.add(magSocket);

  // Trigger guard & trigger
  const guard = mesh(new THREE.TorusGeometry(0.03, 0.005, 6, 18, Math.PI), MAT.steel);
  guard.rotation.set(0, Math.PI / 2, Math.PI);
  guard.position.set(0, -0.012, -0.04);
  root.add(guard);
  const trigger = mesh(rbox(0.006, 0.025, 0.008, 0.002), MAT.steelLight);
  trigger.position.set(0, -0.012, -0.045);
  trigger.rotation.x = 0.25;
  root.add(trigger);

  // Pistol grip
  const grip = mesh(rbox(0.04, 0.12, 0.05, 0.012), MAT.tan, 'grip');
  grip.position.set(0, -0.06, 0.03);
  grip.rotation.x = 0.32;
  root.add(grip);
  const gripSocket = new THREE.Object3D();
  gripSocket.position.set(0, -0.055, 0.035);
  root.add(gripSocket);

  // Stock (extruded side profile)
  const s = new THREE.Shape();
  s.moveTo(0.0, 0.065);
  s.lineTo(0.29, 0.07);
  s.quadraticCurveTo(0.32, 0.07, 0.32, 0.04);
  s.lineTo(0.33, -0.1);
  s.lineTo(0.3, -0.105);
  s.lineTo(0.24, -0.04);
  s.lineTo(0.12, -0.03);
  s.quadraticCurveTo(0.08, -0.03, 0.06, 0.0);
  s.lineTo(0.0, 0.0);
  s.lineTo(0.0, 0.065);
  const hole = new THREE.Path();
  hole.moveTo(0.11, 0.035);
  hole.lineTo(0.25, 0.04);
  hole.quadraticCurveTo(0.27, 0.0, 0.24, -0.01);
  hole.lineTo(0.13, -0.005);
  hole.quadraticCurveTo(0.1, 0.0, 0.11, 0.035);
  s.holes.push(hole);
  const stockGeo = new THREE.ExtrudeGeometry(s, { depth: 0.036, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 10 });
  stockGeo.translate(0, 0, -0.018);
  stockGeo.rotateY(-Math.PI / 2);
  const stock = mesh(stockGeo, MAT.cerakote, 'stock');
  stock.position.set(0, 0.0, 0.04);
  root.add(stock);
  const cheek = mesh(rbox(0.05, 0.022, 0.14, 0.008), MAT.cerakoteDark);
  cheek.position.set(0, 0.078, 0.22);
  root.add(cheek);
  const butt = mesh(rbox(0.05, 0.19, 0.026, 0.01), MAT.rubber);
  butt.position.set(0, -0.015, 0.375);
  root.add(butt);

  // Folded bipod
  const legGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.22, 8);
  legGeo.rotateX(Math.PI / 2);
  for (const x of [-0.016, 0.016]) {
    const leg = mesh(legGeo, MAT.steel);
    leg.position.set(x, -0.03, -0.58);
    root.add(leg);
  }
  const bipodMount = mesh(rbox(0.05, 0.02, 0.03, 0.005), MAT.steel);
  bipodMount.position.set(0, -0.022, -0.68);
  root.add(bipodMount);

  const foreSocket = new THREE.Object3D();
  foreSocket.position.set(-0.045, 0.0, -0.47);
  root.add(foreSocket);
  const ejectPort = new THREE.Object3D();
  ejectPort.position.set(0.04, 0.045, -0.07);
  root.add(ejectPort);

  root.traverse((o) => {
    const mm = o as THREE.Mesh;
    if (mm.isMesh) mm.castShadow = false;
  });

  return { root, bolt, boltSlide, mag, muzzle, ejectPort, gripSocket, foreSocket, boltKnobSocket, magSocket, scopeHeight: scopeH };
}

// ---------- Dagger ----------
export interface DaggerModel {
  root: THREE.Group;
  glow: THREE.Mesh;
  tip: THREE.Object3D;
}

export function createDagger(): DaggerModel {
  const root = new THREE.Group();
  root.name = 'dagger';
  // Blade profile (along +Y), clip-point
  const s = new THREE.Shape();
  s.moveTo(-0.017, 0);
  s.lineTo(-0.018, 0.14);
  s.quadraticCurveTo(-0.014, 0.2, 0.0, 0.245);
  s.lineTo(0.008, 0.2);
  s.quadraticCurveTo(0.018, 0.17, 0.016, 0.12);
  s.lineTo(0.017, 0);
  s.lineTo(-0.017, 0);
  const bladeGeo = new THREE.ExtrudeGeometry(s, { depth: 0.002, bevelEnabled: true, bevelThickness: 0.0035, bevelSize: 0.004, bevelSegments: 1, curveSegments: 12 });
  bladeGeo.translate(0, 0, -0.001);
  const blade = mesh(bladeGeo, MAT.blade, 'blade');
  blade.position.y = 0.012;
  root.add(blade);
  // Fuller groove
  const fuller = mesh(new THREE.BoxGeometry(0.006, 0.12, 0.0075), MAT.steel);
  fuller.position.set(-0.004, 0.085, 0);
  root.add(fuller);
  // Glow shell (edge light when charging)
  const glowGeo = new THREE.ShapeGeometry(s, 12);
  const glow = mesh(glowGeo, MAT.bladeGlow, 'bladeGlow');
  glow.scale.set(1.35, 1.08, 1);
  glow.position.set(0, 0.006, 0);
  const glow2 = mesh(glowGeo, MAT.bladeGlow);
  glow2.rotation.y = Math.PI;
  glow.add(glow2);
  root.add(glow);
  // Guard
  const guard = mesh(rbox(0.075, 0.014, 0.022, 0.005), MAT.steel);
  guard.position.y = 0.006;
  root.add(guard);
  const guardTips = new THREE.SphereGeometry(0.009, 10, 8);
  for (const x of [-0.04, 0.04]) {
    const t = mesh(guardTips, MAT.brass);
    t.position.set(x, 0.006, 0);
    root.add(t);
  }
  // Grip with cord wrap
  const grip = mesh(new THREE.CylinderGeometry(0.0125, 0.014, 0.1, 14), MAT.wrap);
  grip.position.y = -0.05;
  root.add(grip);
  const wrapGeo = new THREE.TorusGeometry(0.0138, 0.0026, 6, 16);
  wrapGeo.rotateX(Math.PI / 2);
  const wraps = new THREE.InstancedMesh(wrapGeo, MAT.strap, 9);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 9; i += 1) wraps.setMatrixAt(i, m4.makeTranslation(0, -0.01 - i * 0.0105, 0));
  root.add(wraps);
  const pommel = mesh(new THREE.OctahedronGeometry(0.017, 1), MAT.steel);
  pommel.scale.set(1, 0.8, 1);
  pommel.position.y = -0.108;
  root.add(pommel);
  const tip = new THREE.Object3D();
  tip.position.y = 0.25;
  root.add(tip);
  return { root, glow, tip };
}

// ---------- Rabbit paw + sleeve ----------
export interface ArmModel {
  root: THREE.Group;
  paw: THREE.Group;
  sleeve: THREE.Group;
  fingers: THREE.Group;
}

function bumpy(geo: THREE.BufferGeometry, amount: number, freq: number, seed: number): THREE.BufferGeometry {
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 1) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * freq + seed) * Math.sin(v.y * freq * 1.3 + seed * 2) * Math.sin(v.z * freq * 0.9 + seed * 3);
    v.multiplyScalar(1 + n * amount);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export function createArm(side: 1 | -1): ArmModel {
  const root = new THREE.Group();
  // Sleeve: oriented along +Y from wrist (y=0) up the forearm, scaled to length at runtime.
  const sleeve = new THREE.Group();
  const sleeveMesh = mesh(new THREE.CylinderGeometry(0.04, 0.052, 1, 14, 4, true), MAT.sleeve);
  sleeveMesh.geometry.translate(0, 0.5, 0);
  sleeve.add(sleeveMesh);
  const strap = mesh(new THREE.CylinderGeometry(0.044, 0.044, 0.03, 14), MAT.strap);
  strap.position.y = 0.09;
  sleeve.add(strap);
  root.add(sleeve);

  const paw = new THREE.Group();
  root.add(paw);
  // Fluffy fur cuff
  const cuff = mesh(bumpy(new THREE.IcosahedronGeometry(0.058, 3), 0.22, 60, side * 3), MAT.fur);
  cuff.scale.set(1, 0.7, 1);
  cuff.position.y = 0.02;
  paw.add(cuff);
  // Palm (paw is built pointing -Y = toward fingers; palm faces -Z by default)
  const palm = mesh(bumpy(new THREE.SphereGeometry(0.046, 20, 16), 0.06, 50, side), MAT.fur);
  palm.scale.set(1.0, 1.15, 0.78);
  palm.position.y = -0.045;
  paw.add(palm);
  // Fingers (curled toes)
  const fingers = new THREE.Group();
  fingers.position.set(0, -0.085, 0);
  paw.add(fingers);
  const toeGeo = bumpy(new THREE.SphereGeometry(0.019, 12, 10), 0.08, 70, side * 2);
  const padGeo = new THREE.SphereGeometry(0.009, 10, 8);
  for (let i = 0; i < 4; i += 1) {
    const toe = mesh(toeGeo, MAT.fur);
    const x = (i - 1.5) * 0.022;
    toe.position.set(x, -0.004 - Math.abs(i - 1.5) * -0.004, -0.008);
    toe.scale.set(1, 1.3, 1);
    fingers.add(toe);
    const pad = mesh(padGeo, MAT.pad);
    pad.position.set(x, -0.012, -0.022);
    pad.scale.set(1, 1, 0.5);
    fingers.add(pad);
  }
  const thumb = mesh(toeGeo, MAT.furShade);
  thumb.position.set(-side * 0.042, -0.05, -0.01);
  thumb.scale.set(1.1, 1.3, 1.1);
  paw.add(thumb);
  const bigPad = mesh(new THREE.SphereGeometry(0.02, 14, 10), MAT.pad);
  bigPad.scale.set(1.2, 1, 0.45);
  bigPad.position.set(0, -0.05, -0.034);
  paw.add(bigPad);

  return { root, paw, sleeve, fingers };
}

/** Brass casing for ejection. */
export function createCasingGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.0065, 0.0065, 0.05, 10);
  const neck = new THREE.CylinderGeometry(0.004, 0.0065, 0.012, 10);
  neck.translate(0, 0.031, 0);
  const merged = mergeGeometries([body, neck]);
  return merged ?? body;
}

/** Radial gradient sprite texture (for flashes/sparks). */
export function radialTexture(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,200,120,0.6)', size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.25, mid);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Star-burst muzzle flash texture. */
export function flashTexture(size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  const spikes = 9;
  for (let i = 0; i < spikes; i += 1) {
    g.save();
    g.rotate((i / spikes) * Math.PI * 2 + (i % 2) * 0.2);
    const len = size * (i % 2 ? 0.32 : 0.48);
    const grd = g.createLinearGradient(0, 0, len, 0);
    grd.addColorStop(0, 'rgba(255,250,220,1)');
    grd.addColorStop(0.4, 'rgba(255,190,90,0.8)');
    grd.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(0, -size * 0.035);
    g.lineTo(len, 0);
    g.lineTo(0, size * 0.035);
    g.fill();
    g.restore();
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, size * 0.18);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(1, 'rgba(255,200,100,0)');
  g.fillStyle = core;
  g.beginPath();
  g.arc(0, 0, size * 0.18, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
