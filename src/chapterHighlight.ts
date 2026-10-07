import * as THREE from "three";
import type { Chapter } from "./chapterStore";
import type { Trajectory } from "./xyzParser";

const HALO_RADIUS = 0.45;

/**
 * Draws the selected chapter in the scene: a translucent halo on each involved
 * atom, green lines for bonds the event forms and red for bonds it breaks.
 * Lives inside the molecule renderer's group, so it uses raw trajectory
 * coordinates and follows the current frame.
 */
export class ChapterHighlight {
  readonly group = new THREE.Group();
  private trajectory: Trajectory | null = null;
  private chapter: Chapter | null = null;
  private frame = 0;
  private haloGeom = new THREE.SphereGeometry(HALO_RADIUS, 16, 12);
  private haloMat = new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.35, depthWrite: false });
  private formedMat = new THREE.LineBasicMaterial({ color: 0x4cd07d });
  private brokenMat = new THREE.LineBasicMaterial({ color: 0xff5a5a });
  private halos: THREE.Mesh[] = [];
  private formedLines: THREE.LineSegments | null = null;
  private brokenLines: THREE.LineSegments | null = null;

  constructor() {
    this.group.renderOrder = 10;
  }

  setTrajectory(trajectory: Trajectory | null) {
    this.trajectory = trajectory;
    this.show(null);
  }

  show(chapter: Chapter | null) {
    this.chapter = chapter;
    this.rebuild();
  }

  setFrame(frame: number) {
    this.frame = frame;
    this.updatePositions();
  }

  private clearObjects() {
    for (const halo of this.halos) this.group.remove(halo);
    this.halos = [];
    for (const lines of [this.formedLines, this.brokenLines]) {
      if (!lines) continue;
      this.group.remove(lines);
      lines.geometry.dispose();
    }
    this.formedLines = null;
    this.brokenLines = null;
  }

  private rebuild() {
    this.clearObjects();
    const chapter = this.chapter;
    if (!chapter || !this.trajectory) return;

    for (let i = 0; i < chapter.atoms.length; i++) {
      const halo = new THREE.Mesh(this.haloGeom, this.haloMat);
      this.halos.push(halo);
      this.group.add(halo);
    }
    const makeLines = (pairs: number, material: THREE.LineBasicMaterial) => {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pairs * 6), 3));
      const lines = new THREE.LineSegments(geom, material);
      lines.frustumCulled = false;
      this.group.add(lines);
      return lines;
    };
    this.formedLines = makeLines(chapter.formed.length, this.formedMat);
    this.brokenLines = makeLines(chapter.broken.length, this.brokenMat);
    this.updatePositions();
  }

  private updatePositions() {
    const chapter = this.chapter;
    const trajectory = this.trajectory;
    if (!chapter || !trajectory) return;
    const frame = Math.min(Math.max(this.frame, 0), trajectory.numFrames - 1);
    const base = frame * trajectory.numAtoms * 3;
    const p = trajectory.positions;

    chapter.atoms.forEach((atom, i) => {
      const off = base + atom * 3;
      this.halos[i]?.position.set(p[off], p[off + 1], p[off + 2]);
    });

    const writePairs = (lines: THREE.LineSegments | null, pairs: [number, number][]) => {
      if (!lines) return;
      const attr = lines.geometry.getAttribute("position") as THREE.BufferAttribute;
      pairs.forEach(([a, b], i) => {
        const offA = base + a * 3;
        const offB = base + b * 3;
        attr.setXYZ(i * 2, p[offA], p[offA + 1], p[offA + 2]);
        attr.setXYZ(i * 2 + 1, p[offB], p[offB + 1], p[offB + 2]);
      });
      attr.needsUpdate = true;
    };
    writePairs(this.formedLines, chapter.formed);
    writePairs(this.brokenLines, chapter.broken);
  }
}
