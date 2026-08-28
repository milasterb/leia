/**
 * The world: an ink-violet field where Leia burns as a candlelight-gold
 * core and seven companions drift on their own orbits as particle clouds.
 *
 * The signature element is the delegation made visible — when a task is
 * routed (by the human OR by a visiting agent's WebMCP call), a beam of
 * particles flows from Leia to the chosen companion, the companion's
 * cloud spins up while it works, and settles when it's done.
 */

import * as THREE from "three";
import type { TeamMemberInfo } from "./api.js";

interface CompanionNode {
  name: string;
  group: THREE.Group;
  cloud: THREE.Points;
  material: THREE.PointsMaterial;
  baseSize: number;
  orbitRadius: number;
  orbitSpeed: number;
  orbitPhase: number;
  height: number;
  working: boolean;
  workingT: number; // 0..1 eased intensity
}

interface Beam {
  points: THREE.Points;
  material: THREE.PointsMaterial;
  offsets: Float32Array;
  start: number;
  duration: number;
  target: CompanionNode;
  positions: Float32Array;
}

export interface SceneHandle {
  setWorking(name: string, working: boolean): void;
  beamTo(name: string): void;
  flashDone(name: string): void;
  dispose(): void;
}

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function gaussian(): number {
  // Box–Muller; good enough for pretty clouds
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeCloudGeometry(count: number, radius: number, shell = 0): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    if (shell > 0) {
      // spherical shell: unit direction * (radius ± shell jitter)
      const dir = new THREE.Vector3(gaussian(), gaussian(), gaussian()).normalize();
      const r = radius + (Math.random() - 0.5) * shell;
      positions[i * 3] = dir.x * r;
      positions[i * 3 + 1] = dir.y * r;
      positions[i * 3 + 2] = dir.z * r;
    } else {
      positions[i * 3] = gaussian() * radius * 0.45;
      positions[i * 3 + 1] = gaussian() * radius * 0.45;
      positions[i * 3 + 2] = gaussian() * radius * 0.45;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function makeLabel(name: string, colorHex: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "600 52px Outfit, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = colorHex;
  ctx.shadowBlur = 26;
  ctx.fillStyle = "rgba(236, 233, 247, 0.92)";
  ctx.fillText(name, 256, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(4.6, 1.15, 1);
  return sprite;
}

export function initScene(canvas: HTMLCanvasElement, team: TeamMemberInfo[]): SceneHandle {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0714, 0.014);

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 400);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x0a0714);

  /* ---------- background dust ---------- */
  const dust = new THREE.Points(
    makeCloudGeometry(2400, 180),
    new THREE.PointsMaterial({
      color: 0x9a90c8,
      size: 0.16,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      sizeAttenuation: true,
    })
  );
  scene.add(dust);

  /* ---------- Leia core ---------- */
  const coreMaterial = new THREE.PointsMaterial({
    color: 0xf5d9a8,
    size: 0.1,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const core = new THREE.Points(makeCloudGeometry(1600, 4.6), coreMaterial);
  scene.add(core);

  const halo = new THREE.Points(
    makeCloudGeometry(320, 3.4, 0.7),
    new THREE.PointsMaterial({
      color: 0xd9ae62,
      size: 0.07,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  scene.add(halo);

  /* ---------- companions ---------- */
  const nodes: CompanionNode[] = team.map((member, i) => {
    const group = new THREE.Group();
    const material = new THREE.PointsMaterial({
      color: new THREE.Color(member.color),
      size: 0.085,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const cloud = new THREE.Points(makeCloudGeometry(430, 1.5, 0.8), material);
    group.add(cloud);

    const label = makeLabel(member.name, member.color);
    label.position.y = -2.5;
    group.add(label);

    scene.add(group);

    const golden = (i / team.length) * Math.PI * 2;
    return {
      name: member.name,
      group,
      cloud,
      material,
      baseSize: 0.085,
      orbitRadius: 13 + (i % 3) * 1.6,
      orbitSpeed: (0.032 + (i % 4) * 0.011) * (i % 2 === 0 ? 1 : -1),
      orbitPhase: golden,
      height: Math.sin(golden * 2.3) * 3.4,
      working: false,
      workingT: 0,
    };
  });

  const byName = new Map(nodes.map((n) => [n.name.toLowerCase(), n]));

  /* ---------- beams ---------- */
  const beams: Beam[] = [];
  const BEAM_COUNT = 110;

  function beamTo(name: string) {
    const target = byName.get(name.toLowerCase());
    if (!target || REDUCED) return;

    const offsets = new Float32Array(BEAM_COUNT);
    for (let i = 0; i < BEAM_COUNT; i++) offsets[i] = Math.random();

    const positions = new Float32Array(BEAM_COUNT * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: new THREE.Color(target.material.color),
      size: 0.14,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);
    beams.push({
      points,
      material,
      offsets,
      positions,
      start: elapsed,
      duration: 1.15,
      target,
    });
  }

  function flashDone(name: string) {
    const node = byName.get(name.toLowerCase());
    if (!node) return;
    node.material.opacity = 1;
    node.material.size = node.baseSize * 2.1;
    // the animate loop eases it back down through workingT
  }

  function setWorking(name: string, working: boolean) {
    const node = byName.get(name.toLowerCase());
    if (node) node.working = working;
  }

  /* ---------- camera control: drag orbit + wheel zoom + idle drift ---------- */
  let theta = 0.9;
  let phi = 1.18;
  let radius = 30;
  let targetTheta = theta;
  let targetPhi = phi;
  let targetRadius = radius;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastInteraction = 0;

  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    lastInteraction = performance.now();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    targetTheta -= (e.clientX - lastX) * 0.0045;
    targetPhi = THREE.MathUtils.clamp(targetPhi - (e.clientY - lastY) * 0.0035, 0.35, 2.6);
    lastX = e.clientX;
    lastY = e.clientY;
    lastInteraction = performance.now();
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onWheel = (e: WheelEvent) => {
    targetRadius = THREE.MathUtils.clamp(targetRadius + e.deltaY * 0.02, 14, 70);
    lastInteraction = performance.now();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  addEventListener("pointermove", onPointerMove);
  addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: true });

  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  addEventListener("resize", onResize);

  /* ---------- animate ---------- */
  const clock = new THREE.Clock();
  let elapsed = 0;
  const targetVec = new THREE.Vector3();
  const startVec = new THREE.Vector3(0, 0, 0);
  const midVec = new THREE.Vector3();
  const pointVec = new THREE.Vector3();
  let raf = 0;

  function animate() {
    raf = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;
    const t = elapsed;

    // core breathing
    const breath = 1 + Math.sin(t * 0.7) * (REDUCED ? 0.008 : 0.03);
    core.scale.setScalar(breath);
    core.rotation.y += dt * 0.05;
    halo.rotation.y -= dt * 0.03;
    halo.rotation.x = Math.sin(t * 0.2) * 0.15;
    dust.rotation.y += dt * 0.004;

    // companions
    for (const node of nodes) {
      const angle = node.orbitPhase + t * (REDUCED ? 0 : node.orbitSpeed);
      node.group.position.set(
        Math.cos(angle) * node.orbitRadius,
        node.height + (REDUCED ? 0 : Math.sin(t * 0.4 + node.orbitPhase) * 0.7),
        Math.sin(angle) * node.orbitRadius
      );

      // ease working intensity 0..1
      const goal = node.working ? 1 : 0;
      node.workingT += (goal - node.workingT) * Math.min(1, dt * 4);

      const w = node.workingT;
      node.cloud.rotation.y += dt * (0.25 + w * (REDUCED ? 0.4 : 2.6));
      node.cloud.rotation.x += dt * w * 0.7;
      node.material.size += (node.baseSize * (1 + w * 0.9) - node.material.size) * Math.min(1, dt * 5);
      node.material.opacity += (0.8 + w * 0.2 - node.material.opacity) * Math.min(1, dt * 5);
      const pulse = 1 + (REDUCED ? 0 : Math.sin(t * (3 + w * 6)) * 0.05 * (0.4 + w));
      node.cloud.scale.setScalar(pulse);
    }

    // beams
    for (let b = beams.length - 1; b >= 0; b--) {
      const beam = beams[b];
      const life = (t - beam.start) / beam.duration;
      if (life >= 1) {
        scene.remove(beam.points);
        beam.points.geometry.dispose();
        beam.material.dispose();
        beams.splice(b, 1);
        continue;
      }
      beam.target.group.getWorldPosition(targetVec);
      midVec.copy(startVec).add(targetVec).multiplyScalar(0.5);
      midVec.y += 4.5; // arc over the field

      for (let i = 0; i < BEAM_COUNT; i++) {
        const p = (life * 1.35 + beam.offsets[i] * 0.4) % 1;
        // quadratic bezier start→mid→target
        const inv = 1 - p;
        pointVec
          .set(0, 0, 0)
          .addScaledVector(startVec, inv * inv)
          .addScaledVector(midVec, 2 * inv * p)
          .addScaledVector(targetVec, p * p);
        beam.positions[i * 3] = pointVec.x + gaussian() * 0.06;
        beam.positions[i * 3 + 1] = pointVec.y + gaussian() * 0.06;
        beam.positions[i * 3 + 2] = pointVec.z + gaussian() * 0.06;
      }
      beam.points.geometry.attributes.position.needsUpdate = true;
      beam.material.opacity = 0.9 * (1 - life * 0.55);
    }

    // camera
    const idleFor = performance.now() - lastInteraction;
    if (!REDUCED && !dragging && idleFor > 3500) {
      targetTheta += dt * 0.03; // gentle auto-drift when left alone
    }
    theta += (targetTheta - theta) * Math.min(1, dt * 6);
    phi += (targetPhi - phi) * Math.min(1, dt * 6);
    radius += (targetRadius - radius) * Math.min(1, dt * 6);
    camera.position.set(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta)
    );
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }
  animate();

  return {
    setWorking,
    beamTo,
    flashDone,
    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onPointerDown);
      removeEventListener("pointermove", onPointerMove);
      removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      removeEventListener("resize", onResize);
      renderer.dispose();
    },
  };
}
