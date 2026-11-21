import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

function detectSoftwareGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function makeFrameCanvasTexture(title: string, timecode: string, accentHex: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 288;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 512, 288);
  grad.addColorStop(0, '#091024');
  grad.addColorStop(1, '#120a2a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 288);

  // Subtle video frame grid & waveform motif
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let x = 32; x < 512; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 288);
    ctx.stroke();
  }

  // Accent bar
  ctx.fillStyle = accentHex;
  ctx.fillRect(24, 24, 6, 44);

  ctx.fillStyle = '#F8FAFC';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(title, 44, 46);

  ctx.fillStyle = accentHex;
  ctx.font = '16px monospace';
  ctx.fillText(timecode, 44, 70);

  // Audio waveform bars inside the floating frame
  for (let i = 0; i < 36; i++) {
    const h = 16 + Math.abs(Math.sin(i * 0.65) * Math.cos(i * 0.25)) * 78;
    ctx.fillStyle = i % 3 === 0 ? '#22D3EE' : accentHex;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(28 + i * 12.5, 220 - h, 7, h);
  }
  ctx.globalAlpha = 1;

  // Timeline scrub strip
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(28, 242, 456, 8);
  ctx.fillStyle = accentHex;
  ctx.fillRect(28, 242, 270, 8);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function HeroOrbCanvas() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [contextLost, setContextLost] = useState(false);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const isSoftwareGl = detectSoftwareGl();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setContextLost(true);
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth || 560, container.clientHeight || 460);
    renderer.shadowMap.enabled = false;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const handleLost = (e: Event) => {
      e.preventDefault();
      setContextLost(true);
    };
    const handleRestored = () => setContextLost(false);
    renderer.domElement.addEventListener('webglcontextlost', handleLost);
    renderer.domElement.addEventListener('webglcontextrestored', handleRestored);

    const scene = new THREE.Scene();
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    const initAspect = (container.clientWidth || 560) / (container.clientHeight || 460);
    const camera = new THREE.PerspectiveCamera(42, initAspect, 0.1, 100);
    camera.position.set(0, 0.15, initAspect < 0.95 ? 9.8 : initAspect < 1.25 ? 7.8 : 6.7);

    // 3-point warm/cool studio lighting
    const hemi = new THREE.HemisphereLight(0x38bdf8, 0x1e1b4b, 0.9);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xfef3c7, 2.0);
    keyLight.position.set(4, 5, 4);
    scene.add(keyLight);

    const rimLight = new THREE.PointLight(0xec4899, 12, 18);
    rimLight.position.set(-3.5, -2.0, 2.5);
    scene.add(rimLight);

    const cyanLight = new THREE.PointLight(0x06b6d4, 12, 18);
    cyanLight.position.set(3.2, 2.2, 2.0);
    scene.add(cyanLight);

    // Composite 3D AI Orb Group (multi-part composite hierarchy, never a single primitive)
    const orbGroup = new THREE.Group();
    scene.add(orbGroup);

    // 1. Inner Neural Core (Faceted metallic crystal)
    const coreGeo = new THREE.IcosahedronGeometry(0.95, 2);
    const coreMat = new THREE.MeshPhysicalMaterial({
      color: 0x3b82f6,
      emissive: 0x1d4ed8,
      emissiveIntensity: 0.7,
      metalness: 0.85,
      roughness: 0.16,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    orbGroup.add(coreMesh);

    // 2. Geodesic Wireframe Shell
    const shellGeo = new THREE.IcosahedronGeometry(1.22, 1);
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0x22d3ee,
      emissive: 0x06b6d4,
      emissiveIntensity: 0.6,
      wireframe: true,
      roughness: 0.25,
      metalness: 0.9,
    });
    const shellMesh = new THREE.Mesh(shellGeo, shellMat);
    orbGroup.add(shellMesh);

    // 3. Three Orbital Timeline Rings (TorusGeometry)
    const ringGeo1 = new THREE.TorusGeometry(1.62, 0.025, 12, 64);
    const ringMat1 = new THREE.MeshStandardMaterial({
      color: 0x22d3ee,
      emissive: 0x0891b2,
      emissiveIntensity: 0.8,
      metalness: 0.9,
      roughness: 0.2,
    });
    const ring1 = new THREE.Mesh(ringGeo1, ringMat1);
    ring1.rotation.x = Math.PI / 2.6;
    orbGroup.add(ring1);

    const ringGeo2 = new THREE.TorusGeometry(1.88, 0.02, 12, 64);
    const ringMat2 = new THREE.MeshStandardMaterial({
      color: 0xa855f7,
      emissive: 0x7e22ce,
      emissiveIntensity: 0.8,
      metalness: 0.9,
      roughness: 0.22,
    });
    const ring2 = new THREE.Mesh(ringGeo2, ringMat2);
    ring2.rotation.x = -Math.PI / 3.2;
    ring2.rotation.y = Math.PI / 5;
    orbGroup.add(ring2);

    const ringGeo3 = new THREE.TorusGeometry(2.14, 0.015, 10, 64);
    const ringMat3 = new THREE.MeshStandardMaterial({
      color: 0xec4899,
      emissive: 0xdb2777,
      emissiveIntensity: 0.75,
      metalness: 0.85,
      roughness: 0.28,
    });
    const ring3 = new THREE.Mesh(ringGeo3, ringMat3);
    ring3.rotation.y = Math.PI / 2.4;
    orbGroup.add(ring3);

    // 4. Radial Audio Waveform Bars (InstancedMesh of 32 bars around equator)
    const barCount = 32;
    const barGeo = new THREE.BoxGeometry(0.055, 0.28, 0.055);
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.75,
      metalness: 0.7,
      roughness: 0.25,
    });
    const waveformBars = new THREE.InstancedMesh(barGeo, barMat, barCount);
    waveformBars.frustumCulled = false;
    orbGroup.add(waveformBars);

    // 5. Floating Holographic Video Frames around the Orb
    const frameSpecs = [
      { title: 'KEYNOTE CUT', time: '00:14.2 -> 00:48.0', color: '#22D3EE', pos: [-2.35, 1.05, 0.4], rot: [0.1, 0.35, -0.05] },
      { title: 'AI SEARCH HIT', time: 'Pricing · 00:34.8', color: '#A855F7', pos: [2.4, 0.85, 0.25], rot: [-0.08, -0.4, 0.06] },
      { title: 'CAPTION SYNC', time: '100% Protected', color: '#10B981', pos: [-2.15, -1.1, 0.55], rot: [-0.12, 0.3, 0.04] },
      { title: 'FAST HOOK VER', time: '00:28.5 · 1.15x', color: '#EC4899', pos: [2.25, -0.95, 0.5], rot: [0.1, -0.32, -0.05] },
    ];

    const frameTextures: THREE.CanvasTexture[] = [];
    const frameGroups: Array<{ group: THREE.Group; baseY: number; phase: number }> = [];
    const cardGeo = new THREE.PlaneGeometry(1.42, 0.8);
    const frameBezelGeo = new THREE.BoxGeometry(1.48, 0.86, 0.04);
    const frameBezelMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      metalness: 0.8,
      roughness: 0.3,
    });

    frameSpecs.forEach((spec, idx) => {
      const tex = makeFrameCanvasTexture(spec.title, spec.time, spec.color);
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      frameTextures.push(tex);
      const cardMat = new THREE.MeshBasicMaterial({ map: tex });
      const fg = new THREE.Group();
      const bezel = new THREE.Mesh(frameBezelGeo, frameBezelMat);
      const face = new THREE.Mesh(cardGeo, cardMat);
      face.position.z = 0.025;
      fg.add(bezel, face);
      fg.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      fg.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
      scene.add(fg);
      frameGroups.push({ group: fg, baseY: spec.pos[1], phase: idx * 1.4 });
    });

    // 6. Starfield / Ambient Particle Dust (InstancedMesh)
    const dustCount = 48;
    const dustGeo = new THREE.OctahedronGeometry(0.03, 0);
    const dustMat = new THREE.MeshBasicMaterial({ color: 0x67e8f9 });
    const dustMesh = new THREE.InstancedMesh(dustGeo, dustMat, dustCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < dustCount; i++) {
      const angle = (i / dustCount) * Math.PI * 2;
      const rad = 2.6 + (i % 5) * 0.45;
      dummy.position.set(
        Math.cos(angle) * rad,
        ((i % 7) - 3) * 0.55,
        Math.sin(angle) * rad * 0.6 - 0.8,
      );
      dummy.updateMatrix();
      dustMesh.setMatrixAt(i, dummy.matrix);
    }
    dustMesh.computeBoundingSphere();
    scene.add(dustMesh);

    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth || 560;
      const h = container.clientHeight || 460;
      const aspect = w / h;
      camera.aspect = aspect;
      camera.position.z = aspect < 0.95 ? 9.8 : aspect < 1.25 ? 7.8 : 6.7;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.render(scene, camera);
    });
    resizeObserver.observe(container);

    let frameId = 0;
    let disposed = false;
    const startMs = performance.now();
    const _dummy = new THREE.Object3D();

    function updateScene(elapsed: number) {
      coreMesh.rotation.y = elapsed * 0.35;
      coreMesh.rotation.x = Math.sin(elapsed * 0.25) * 0.15;
      shellMesh.rotation.y = -elapsed * 0.22;
      ring1.rotation.z = elapsed * 0.45;
      ring2.rotation.z = -elapsed * 0.32;
      ring3.rotation.x = elapsed * 0.28;

      for (let i = 0; i < barCount; i++) {
        const angle = (i / barCount) * Math.PI * 2 + elapsed * 0.35;
        const r = 1.44;
        const amp = 0.55 + Math.abs(Math.sin(elapsed * 2.6 + i * 0.55)) * 1.35;
        _dummy.position.set(Math.cos(angle) * r, Math.sin(angle) * r * 0.22, Math.sin(angle) * r);
        _dummy.lookAt(0, 0, 0);
        _dummy.scale.set(1, amp, 1);
        _dummy.updateMatrix();
        waveformBars.setMatrixAt(i, _dummy.matrix);
      }
      waveformBars.instanceMatrix.needsUpdate = true;

      for (const fg of frameGroups) {
        fg.group.position.y = fg.baseY + Math.sin(elapsed * 1.1 + fg.phase) * 0.12;
      }
      dustMesh.rotation.y = elapsed * 0.06;
    }

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      if (disposed) return;
      const elapsed = (performance.now() - startMs) / 1000;
      updateScene(elapsed);
      renderer.render(scene, camera);
      if (prefersReducedMotion) return;
      if (isSoftwareGl) afterDraw(tick);
      else frameId = requestAnimationFrame(tick);
    }

    // Initial render
    updateScene(0.8);
    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', handleLost);
      renderer.domElement.removeEventListener('webglcontextrestored', handleRestored);

      coreGeo.dispose();
      coreMat.dispose();
      shellGeo.dispose();
      shellMat.dispose();
      ringGeo1.dispose();
      ringMat1.dispose();
      ringGeo2.dispose();
      ringMat2.dispose();
      ringGeo3.dispose();
      ringMat3.dispose();
      barGeo.dispose();
      barMat.dispose();
      cardGeo.dispose();
      frameBezelGeo.dispose();
      frameBezelMat.dispose();
      frameTextures.forEach((t) => t.dispose());
      dustGeo.dispose();
      dustMat.dispose();
      scene.environment?.dispose();
      renderer.dispose();
    };
  }, []);

  if (contextLost) {
    return (
      <div
        data-testid="hero-orb-fallback"
        className="w-full h-full flex items-center justify-center rounded-2xl border border-cyan-500/25 bg-gradient-to-br from-cyan-950/50 via-indigo-950/40 to-fuchsia-950/40"
      >
        <div className="w-48 h-48 rounded-full bg-gradient-to-tr from-cyan-400 via-violet-500 to-pink-500 opacity-80 blur-[1px] flex items-center justify-center">
          <div className="w-32 h-32 rounded-full bg-[#050711] border border-cyan-400/50 flex items-center justify-center text-xs font-mono text-cyan-300">
            EDITMIND CORE
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={mountRef}
      data-testid="hero-orb-canvas"
      className="w-full h-full min-h-[380px]"
      aria-label="Interactive 3D AI Editing Orb"
    />
  );
}
