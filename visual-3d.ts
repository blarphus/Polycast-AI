/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// tslint:disable:organize-imports
// tslint:disable:ban-malformed-import-paths
// tslint:dsiable:no-new-decorators

import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {Analyser} from './analyser';

import * as THREE from 'three';
import {EXRLoader} from 'three/addons/loaders/EXRLoader.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
// import {FXAAShader} from 'three/addons/shaders/FXAAShader.js'; // FXAA currently not used
import {fs as backdropFS, vs as backdropVS} from './backdrop-shader';
import {vs as sphereVS} from './sphere-shader';

/**
 * 3D live audio visual.
 */
@customElement('gdm-live-audio-visuals-3d')
export class GdmLiveAudioVisuals3D extends LitElement {
  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private camera!: THREE.PerspectiveCamera;
  private backdrop!: THREE.Mesh;
  private composer!: EffectComposer;
  private sphere!: THREE.Mesh;
  private prevTime = 0;
  private rotation = new THREE.Vector3(0, 0, 0);
  private renderer!: THREE.WebGLRenderer; // Store renderer as class member

  private _outputNode!: AudioNode;

  @property()
  set outputNode(node: AudioNode) {
    this._outputNode = node;
    if (this.outputNode) {
      this.outputAnalyser = new Analyser(this._outputNode);
    }
  }

  get outputNode() {
    return this._outputNode;
  }

  private _inputNode!: AudioNode;

  @property()
  set inputNode(node: AudioNode) {
    this._inputNode = node;
    if (this._inputNode) {
      this.inputAnalyser = new Analyser(this._inputNode);
    }
  }

  get inputNode() {
    return this._inputNode;
  }

  private canvas!: HTMLCanvasElement;

  static styles = css`
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
      display: block; /* Ensure canvas takes up block space */
      image-rendering: pixelated;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('resize', this.onWindowResize);
    if (this.renderer) {
      this.renderer.dispose();
    }
    if (this.composer) {
      // Dispose passes if necessary
    }
  }
  
  public triggerResize() {
    // This method might be called before the component is fully initialized
    // or if its canvas is not yet available.
    if (this.canvas && this.camera && this.composer && this.backdrop && this.renderer) {
        this.onWindowResize();
    } else {
        // console.warn('Visualizer triggerResize called but component not fully ready.');
        // It's possible init hasn't run yet if parent resized it very early.
        // Deferring slightly can help if init is pending.
        requestAnimationFrame(() => {
          if (this.canvas && this.camera && this.composer && this.backdrop && this.renderer) {
            this.onWindowResize();
          } else {
            console.warn('Visualizer triggerResize still not ready after defer.');
          }
        });
    }
  }

  private onWindowResize() {
    if (!this.canvas || !this.camera || !this.composer || !this.backdrop || !this.renderer) return;

    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;

    if (width === 0 || height === 0) return; 

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    const dPR = this.renderer.getPixelRatio(); 

    const backdropMaterial = this.backdrop.material as THREE.RawShaderMaterial;
    backdropMaterial.uniforms.resolution.value.set(width * dPR, height * dPR);
    
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
  }


  private init() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x100c14);

    this.backdrop = new THREE.Mesh(
      new THREE.IcosahedronGeometry(10, 5),
      new THREE.RawShaderMaterial({
        uniforms: {
          resolution: {value: new THREE.Vector2(this.canvas.clientWidth * window.devicePixelRatio, this.canvas.clientHeight * window.devicePixelRatio)},
          rand: {value: 0},
        },
        vertexShader: backdropVS,
        fragmentShader: backdropFS,
        glslVersion: THREE.GLSL3,
      }),
    );
    this.backdrop.material.side = THREE.BackSide;
    scene.add(this.backdrop);

    this.camera = new THREE.PerspectiveCamera(
      75,
      this.canvas.clientWidth / this.canvas.clientHeight, 
      0.1,
      1000,
    );
    this.camera.position.set(2, -2, 8); 


    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true, 
    });
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);


    const geometry = new THREE.IcosahedronGeometry(1, 10);
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);

    const sphereMaterial = new THREE.MeshStandardMaterial({
      color: 0x000010,
      metalness: 0.5,
      roughness: 0.1,
      emissive: 0x000010,
      emissiveIntensity: 1.5,
    });

    new EXRLoader().load(
      '/piz_compressed.exr',
      (texture: THREE.Texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const exrCubeRenderTarget = pmremGenerator.fromEquirectangular(texture);
        sphereMaterial.envMap = exrCubeRenderTarget.texture;
        if (this.sphere) this.sphere.visible = true;
        
        if (texture && typeof texture.dispose === 'function') {
          texture.dispose(); 
        }
        if (pmremGenerator && typeof pmremGenerator.dispose === 'function') {
          pmremGenerator.dispose();
        }
      },
    );

    sphereMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = {value: 0};
      shader.uniforms.inputData = {value: new THREE.Vector4()};
      shader.uniforms.outputData = {value: new THREE.Vector4()};

      sphereMaterial.userData.shader = shader;
      shader.vertexShader = sphereVS;
    };

    this.sphere = new THREE.Mesh(geometry, sphereMaterial);
    scene.add(this.sphere);
    this.sphere.visible = false; 

    const renderPass = new RenderPass(scene, this.camera);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.canvas.clientWidth, this.canvas.clientHeight),
      5, 
      0.5, 
      0, 
    );


    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    this.composer.addPass(bloomPass);
    
    this.onWindowResize = this.onWindowResize.bind(this);
    window.addEventListener('resize', this.onWindowResize);
    
    this.onWindowResize(); 

    this.animation();
  }

  private animation() {
    requestAnimationFrame(() => this.animation());

    if (!this.inputAnalyser || !this.outputAnalyser || !this.composer || !this.sphere) return;


    this.inputAnalyser.update();
    this.outputAnalyser.update();

    const t = performance.now();
    const dt = (t - this.prevTime) / (1000 / 60); 
    this.prevTime = t;

    const backdropMaterial = this.backdrop.material as THREE.RawShaderMaterial;
    backdropMaterial.uniforms.rand.value = Math.random() * 10000;

    const sphereMaterial = this.sphere.material as THREE.MeshStandardMaterial;
    if (sphereMaterial.userData.shader) {
      this.sphere.scale.setScalar(
        1 + (0.2 * this.outputAnalyser.data[1]) / 255,
      );

      const f = 0.001;
      this.rotation.x += (dt * f * 0.5 * this.outputAnalyser.data[1]) / 255;
      this.rotation.z += (dt * f * 0.5 * this.inputAnalyser.data[1]) / 255;
      this.rotation.y += (dt * f * 0.25 * this.inputAnalyser.data[2]) / 255;
      this.rotation.y += (dt * f * 0.25 * this.outputAnalyser.data[2]) / 255;

      const euler = new THREE.Euler(
        this.rotation.x,
        this.rotation.y,
        this.rotation.z,
      );
      const quaternion = new THREE.Quaternion().setFromEuler(euler);
      const vector = new THREE.Vector3(0, 0, this.camera.position.z); 
      vector.applyQuaternion(quaternion);
      
      this.camera.lookAt(this.sphere.position);


      sphereMaterial.userData.shader.uniforms.time.value +=
        (dt * 0.1 * this.outputAnalyser.data[0]) / 255;
      sphereMaterial.userData.shader.uniforms.inputData.value.set(
        (1 * this.inputAnalyser.data[0]) / 255,
        (0.1 * this.inputAnalyser.data[1]) / 255,
        (10 * this.inputAnalyser.data[2]) / 255,
        0,
      );
      sphereMaterial.userData.shader.uniforms.outputData.value.set(
        (2 * this.outputAnalyser.data[0]) / 255,
        (0.1 * this.outputAnalyser.data[1]) / 255,
        (10 * this.outputAnalyser.data[2]) / 255,
        0,
      );
    }

    this.composer.render();
  }

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas') as HTMLCanvasElement;
    if (this.inputNode && !this.inputAnalyser) {
      this.inputAnalyser = new Analyser(this.inputNode);
    }
    if (this.outputNode && !this.outputAnalyser) {
      this.outputAnalyser = new Analyser(this.outputNode);
    }
    
    requestAnimationFrame(() => {
        if (this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0) {
           this.init();
        } else {
            setTimeout(() => this.init(), 50); 
        }
    });
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio-visuals-3d': GdmLiveAudioVisuals3D;
  }
}