import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const LOW_FX = new URLSearchParams(location.search).has('lowfx');

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSlow: { value: 0 },
    uDamage: { value: 0 },
    uAberration: { value: 0 },
    uTime: { value: 0 },
    uScope: { value: 0 },
    uCharge: { value: 0 },
    uSpeed: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uSlow; uniform float uDamage; uniform float uAberration;
    uniform float uTime; uniform float uScope; uniform float uCharge; uniform float uSpeed; uniform float uAspect;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r = length(c * vec2(uAspect, 1.0));
      // Radial speed blur (dash / flips)
      vec3 col;
      float ab = uAberration * (0.4 + r * 1.6) + uSlow * 0.0025 * r;
      if (uSpeed > 0.001) {
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 8; i++) {
          float k = float(i) / 7.0;
          vec2 suv = 0.5 + c * (1.0 - k * uSpeed * 0.08 * r);
          acc += texture2D(tDiffuse, suv).rgb;
        }
        col = acc / 8.0;
      } else {
        col.r = texture2D(tDiffuse, uv + c * ab).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - c * ab).b;
      }
      // Slow-motion grade: desaturate, cool shadows, warm highlights
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      vec3 graded = mix(col, vec3(l), 0.45);
      graded = mix(graded, graded * vec3(0.82, 0.95, 1.18), 0.6);
      graded += vec3(0.05, 0.03, 0.0) * smoothstep(0.6, 1.0, l);
      col = mix(col, graded, uSlow);
      // Charge tint (cyan edges)
      col += vec3(0.1, 0.5, 0.7) * uCharge * smoothstep(0.35, 0.85, r) * 0.35;
      // Vignette
      float vig = smoothstep(0.95, 0.25 - uSlow * 0.1, r);
      col *= mix(1.0, vig, 0.35 + uSlow * 0.45);
      // Damage
      col = mix(col, vec3(0.7, 0.02, 0.02), uDamage * smoothstep(0.25, 0.9, r) * 0.85);
      // Grain
      col += (hash(uv * 1024.0 + uTime) - 0.5) * (0.025 + uSlow * 0.03);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class PostFx {
  readonly composer: EffectComposer;
  readonly grade: ShaderPass;
  readonly bloom: UnrealBloomPass;
  private readonly worldPass: RenderPass;
  private readonly vmPass: RenderPass;

  constructor(renderer: THREE.WebGLRenderer, world: THREE.Scene, camera: THREE.Camera, vmScene: THREE.Scene, vmCamera: THREE.Camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: LOW_FX ? 0 : 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.worldPass = new RenderPass(world, camera);
    this.vmPass = new RenderPass(vmScene, vmCamera);
    this.vmPass.clear = false;
    this.vmPass.clearDepth = true;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.5, 0.97);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.worldPass);
    this.composer.addPass(this.vmPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  setSize(w: number, h: number, dpr: number): void {
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.grade.uniforms.uAspect.value = w / h;
  }

  render(dt: number): void {
    this.grade.uniforms.uTime.value += dt;
    this.composer.render(dt);
  }
}
