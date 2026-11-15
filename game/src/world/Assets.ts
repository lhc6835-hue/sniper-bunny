import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

const BASE = `${import.meta.env.BASE_URL}assets/models/`;

export const NATURE = [
  'rock_largeA', 'rock_largeB', 'rock_largeC', 'rock_largeD', 'rock_tallA', 'rock_tallB', 'rock_tallE',
  'stone_largeA', 'stone_tallB', 'tree_oak', 'tree_default', 'tree_fat', 'tree_detailed', 'tree_pineRoundA',
  'tree_pineTallA_detailed', 'tree_blocks', 'plant_bushLarge', 'plant_bushDetailed', 'grass_large', 'grass',
  'flower_redA', 'flower_yellowA', 'flower_purpleA', 'mushroom_redGroup', 'log_large', 'stump_roundDetailed',
  'statue_columnDamaged', 'statue_ring', 'crop_carrot', 'fence_simple', 'cliff_large_rock', 'cliff_block_rock',
  'cliff_large_stone', 'cliff_block_stone', 'cliff_blockHalf_stone', 'rock_largeE', 'rock_largeF', 'stone_largeB', 'stone_largeC', 'stone_tallA', 'stone_tallE',
] as const;

export const SPACE = [
  'hangar_roundA', 'hangar_smallA', 'machine_generatorLarge', 'machine_barrelLarge', 'satelliteDish_large',
  'structure_detailed', 'barrels', 'crater', 'craterLarge', 'rock_crystalsLargeA', 'turret_double',
  'supports_high', 'platform_large', 'meteor_detailed', 'pipe_straight',
] as const;

export type PropName = (typeof NATURE)[number] | (typeof SPACE)[number];

export class Assets {
  readonly props = new Map<PropName, THREE.Group>();
  robot!: GLTF;

  async load(onProgress: (p: number) => void): Promise<void> {
    const loader = new GLTFLoader();
    const jobs: Array<[string, string]> = [
      ...NATURE.map((n) => [n, `${BASE}nature/${n}.glb`] as [string, string]),
      ...SPACE.map((n) => [n, `${BASE}space/${n}.glb`] as [string, string]),
    ];
    let done = 0;
    const total = jobs.length + 1;
    const tick = () => onProgress(++done / total);
    await Promise.all([
      ...jobs.map(async ([name, url]) => {
        const gltf = await loader.loadAsync(url);
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = true;
          }
        });
        this.props.set(name as PropName, gltf.scene);
        tick();
      }),
      loader.loadAsync(`${BASE}RobotExpressive.glb`).then((g) => {
        this.robot = g;
        tick();
      }),
    ]);
  }

  /** Clone a prop normalized so its height equals `height` and its base sits at y=0. */
  prop(name: PropName, height: number, byWidth = false): THREE.Group {
    const src = this.props.get(name);
    if (!src) throw new Error(`Missing prop ${name}`);
    const inner = src.clone(true);
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const s = height / Math.max(byWidth ? Math.max(size.x, size.z) : size.y, 1e-3);
    inner.scale.setScalar(s);
    const center = box.getCenter(new THREE.Vector3());
    inner.position.set(-center.x * s, -box.min.y * s, -center.z * s);
    const g = new THREE.Group();
    g.add(inner);
    return g;
  }

  /** Extract mesh parts of a prop (geometry baked to normalized space) for instancing. */
  parts(name: PropName, height: number): Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> {
    const g = this.prop(name, height);
    g.updateMatrixWorld(true);
    const out: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> = [];
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const geo = m.geometry.clone();
      geo.applyMatrix4(m.matrixWorld);
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats.length === 1) out.push({ geometry: geo, material: mats[0] });
      else {
        for (let i = 0; i < geo.groups.length; i += 1) {
          const grp = geo.groups[i];
          const sub = geo.clone();
          sub.clearGroups();
          sub.setDrawRange(grp.start, grp.count);
          out.push({ geometry: sub, material: mats[grp.materialIndex ?? 0] });
        }
      }
    });
    return out;
  }
}
