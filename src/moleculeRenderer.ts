import * as THREE from "three";
import type { Trajectory } from "./xyzParser";
import { getElementInfo } from "./elements";
import { bondCutoff, computeBonds } from "./bonds";
import { frameCell, separation } from "./cell";

const ATOM_SPHERE_SCALE = 0.35; // shrink covalent radius for a ball-and-stick look
const BOND_RADIUS = 0.08;

function getAtomSymbol(trajectory: Trajectory, frameIndex: number, atomIndex: number): string {
  return trajectory.frameSymbols[frameIndex * trajectory.numAtoms + atomIndex] ?? trajectory.symbols[atomIndex] ?? "X";
}

function writeFrameSymbols(trajectory: Trajectory, frameIndex: number, symbols: string[]) {
  for (let i = 0; i < trajectory.numAtoms; i++) {
    symbols[i] = getAtomSymbol(trajectory, frameIndex, i);
  }
}

function getMaxAtomCountsBySymbol(trajectory: Trajectory): Map<string, number> {
  const maxCounts = new Map<string, number>();
  const frameCounts = new Map<string, number>();

  for (let frame = 0; frame < trajectory.numFrames; frame++) {
    frameCounts.clear();
    for (let atomIndex = 0; atomIndex < trajectory.numAtoms; atomIndex++) {
      const symbol = getAtomSymbol(trajectory, frame, atomIndex);
      frameCounts.set(symbol, (frameCounts.get(symbol) ?? 0) + 1);
    }
    for (const [symbol, count] of frameCounts) {
      maxCounts.set(symbol, Math.max(maxCounts.get(symbol) ?? 0, count));
    }
  }

  return maxCounts;
}

/**
 * Renders a trajectory frame using one InstancedMesh per element seen in the
 * trajectory plus one InstancedMesh for bonds. Updating a frame rewrites
 * instance matrices and the current atom-to-element mesh mapping.
 */
export class MoleculeRenderer {
  readonly group = new THREE.Group();

  private trajectory: Trajectory;
  private atomMeshes = new Map<string, THREE.InstancedMesh>();
  private bondMesh: THREE.InstancedMesh;
  private bondCapacity: number;
  private currentFrame = -1;
  private bondCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
  private atomTransform = new THREE.Object3D();
  private bondTransform = new THREE.Object3D();
  private frameSymbolsScratch: string[];
  private bondStart = new THREE.Vector3();
  private bondEnd = new THREE.Vector3();
  private bondMidpoint = new THREE.Vector3();
  private bondDirection = new THREE.Vector3();
  private bondUp = new THREE.Vector3(0, 1, 0);
  private bondQuaternion = new THREE.Quaternion();

  constructor(trajectory: Trajectory) {
    this.trajectory = trajectory;
    this.frameSymbolsScratch = new Array<string>(trajectory.numAtoms);

    for (const [symbol, maxCount] of getMaxAtomCountsBySymbol(trajectory)) {
      const info = getElementInfo(symbol);
      const geom = new THREE.SphereGeometry(info.radius * ATOM_SPHERE_SCALE, 16, 12);
      const mat = new THREE.MeshStandardMaterial({ color: info.color, roughness: 0.4, metalness: 0.05 });
      const mesh = new THREE.InstancedMesh(geom, mat, maxCount);
      mesh.count = 0;
      mesh.userData.symbol = symbol;
      mesh.userData.atomIndices = [];
      // InstancedMesh frustum culling tests the original (origin-centered)
      // geometry bounds, not the spread of instance positions, so the whole
      // mesh can vanish once the centroid leaves the frustum. Disable it.
      mesh.frustumCulled = false;
      this.atomMeshes.set(symbol, mesh);
      this.group.add(mesh);
    }

    // Bond mesh capacity: heuristic upper bound, grown lazily if exceeded.
    this.bondCapacity = Math.max(trajectory.numAtoms * 2, 64);
    const bondMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6 });
    this.bondMesh = new THREE.InstancedMesh(this.bondCylinderGeom, bondMat, this.bondCapacity);
    this.bondMesh.count = 0;
    this.bondMesh.frustumCulled = false;
    this.group.add(this.bondMesh);

    this.setFrame(0);
    this.centerOnFirstFrame();
  }

  dispose() {
    for (const mesh of [...this.atomMeshes.values(), this.bondMesh]) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.atomMeshes.clear();
  }

  private centerOnFirstFrame() {
    const { positions, numAtoms } = this.trajectory;
    const center = new THREE.Vector3();
    for (let i = 0; i < numAtoms; i++) {
      center.x += positions[i * 3];
      center.y += positions[i * 3 + 1];
      center.z += positions[i * 3 + 2];
    }
    center.divideScalar(numAtoms);
    this.group.position.set(-center.x, -center.y, -center.z);
  }

  setFrame(frameIndex: number) {
    if (frameIndex === this.currentFrame) return;
    this.currentFrame = frameIndex;
    const { positions, numAtoms } = this.trajectory;
    const base = frameIndex * numAtoms * 3;

    for (const mesh of this.atomMeshes.values()) {
      mesh.count = 0;
      (mesh.userData.atomIndices as number[]).length = 0;
    }

    for (let atomIndex = 0; atomIndex < numAtoms; atomIndex++) {
      const symbol = getAtomSymbol(this.trajectory, frameIndex, atomIndex);
      const mesh = this.atomMeshes.get(symbol);
      if (!mesh) continue;

      const off = base + atomIndex * 3;
      this.atomTransform.position.set(positions[off], positions[off + 1], positions[off + 2]);
      this.atomTransform.updateMatrix();
      mesh.setMatrixAt(mesh.count, this.atomTransform.matrix);
      (mesh.userData.atomIndices as number[]).push(atomIndex);
      mesh.count += 1;
    }

    for (const mesh of this.atomMeshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    this.updateBonds(frameIndex);
  }

  private updateBonds(frameIndex: number) {
    writeFrameSymbols(this.trajectory, frameIndex, this.frameSymbolsScratch);
    const bonds = computeBonds(
      this.trajectory.positions,
      frameIndex,
      this.trajectory.numAtoms,
      this.frameSymbolsScratch,
      frameCell(this.trajectory, frameIndex),
    );

    const { positions, numAtoms } = this.trajectory;
    const base = frameIndex * numAtoms * 3;

    // A bond across a periodic cell wall is drawn as two halves, each from its
    // atom toward the partner's nearest image, rather than one long cylinder
    // through the box.
    const segments: number[] = [];
    for (const bond of bonds) {
      const a = base + bond.a * 3;
      const b = base + bond.b * 3;
      const [dx, dy, dz] = separation(this.trajectory, frameIndex, bond.a, bond.b);
      const direct = Math.abs(positions[b] - positions[a] - dx) + Math.abs(positions[b + 1] - positions[a + 1] - dy) +
        Math.abs(positions[b + 2] - positions[a + 2] - dz) < 1e-3;
      if (direct) {
        segments.push(positions[a], positions[a + 1], positions[a + 2], positions[b], positions[b + 1], positions[b + 2]);
      } else {
        segments.push(positions[a], positions[a + 1], positions[a + 2], positions[a] + dx / 2, positions[a + 1] + dy / 2, positions[a + 2] + dz / 2);
        segments.push(positions[b], positions[b + 1], positions[b + 2], positions[b] - dx / 2, positions[b + 1] - dy / 2, positions[b + 2] - dz / 2);
      }
    }

    const count = segments.length / 6;
    if (count > this.bondCapacity) {
      this.growBondCapacity(count);
    }

    for (let i = 0; i < count; i++) {
      const s = i * 6;
      this.bondStart.set(segments[s], segments[s + 1], segments[s + 2]);
      this.bondEnd.set(segments[s + 3], segments[s + 4], segments[s + 5]);
      this.bondMidpoint.copy(this.bondStart).add(this.bondEnd).multiplyScalar(0.5);
      this.bondDirection.copy(this.bondEnd).sub(this.bondStart);
      const len = this.bondDirection.length();
      this.bondDirection.normalize();
      this.bondQuaternion.setFromUnitVectors(this.bondUp, this.bondDirection);

      this.bondTransform.position.copy(this.bondMidpoint);
      this.bondTransform.quaternion.copy(this.bondQuaternion);
      this.bondTransform.scale.set(BOND_RADIUS, len, BOND_RADIUS);
      this.bondTransform.updateMatrix();
      this.bondMesh.setMatrixAt(i, this.bondTransform.matrix);
    }
    this.bondMesh.count = count;
    this.bondMesh.instanceMatrix.needsUpdate = true;
  }

  private growBondCapacity(minCapacity: number) {
    const newCapacity = Math.max(minCapacity, this.bondCapacity * 2);
    const oldMesh = this.bondMesh;
    this.group.remove(oldMesh);
    this.bondMesh = new THREE.InstancedMesh(this.bondCylinderGeom, oldMesh.material, newCapacity);
    this.bondMesh.count = 0;
    this.bondMesh.frustumCulled = false;
    this.bondCapacity = newCapacity;
    this.group.add(this.bondMesh);
  }

  /** Returns {symbol, atomIndex} for a hit on an atom InstancedMesh, given a raycaster intersection. */
  resolveAtomHit(mesh: THREE.Object3D, instanceId: number): { symbol: string; atomIndex: number } | null {
    if (!(mesh instanceof THREE.InstancedMesh)) return null;
    const indices: number[] | undefined = mesh.userData.atomIndices;
    if (!indices) return null;
    const atomIndex = indices[instanceId];
    if (atomIndex === undefined) return null;
    return { symbol: mesh.userData.symbol, atomIndex };
  }

  getAtomMeshes(): THREE.InstancedMesh[] {
    return Array.from(this.atomMeshes.values());
  }

  /** Element and bonded neighbors of an atom in the frame on screen (for hover labels). */
  atomInfo(atomIndex: number): { symbol: string; neighbors: Array<{ atom: number; symbol: string; distance: number }> } {
    const t = this.trajectory;
    const frame = Math.max(this.currentFrame, 0);
    const symbol = getAtomSymbol(t, frame, atomIndex);
    const neighbors: Array<{ atom: number; symbol: string; distance: number }> = [];
    for (let j = 0; j < t.numAtoms; j++) {
      if (j === atomIndex) continue;
      const [dx, dy, dz] = separation(t, frame, atomIndex, j);
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 25) continue; // no bond is longer than 5 Å
      const other = getAtomSymbol(t, frame, j);
      const distance = Math.sqrt(d2);
      if (distance <= bondCutoff(symbol, other)) neighbors.push({ atom: j, symbol: other, distance });
    }
    neighbors.sort((a, b) => a.distance - b.distance);
    return { symbol, neighbors };
  }

  getAtomWorldPosition(atomIndex: number, target: THREE.Vector3): THREE.Vector3 {
    const { positions } = this.trajectory;
    const base = this.currentFrame * this.trajectory.numAtoms * 3;
    const off = base + atomIndex * 3;
    target.set(positions[off], positions[off + 1], positions[off + 2]);
    return this.group.localToWorld(target);
  }
}
