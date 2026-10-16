// Port of the grid half of the original editor's MainScene.
//
// Original: new Plane(7500, 7500, 15, 15) with a WireMaterial, offset by
// +hBase on X and Y, mouseEnabled = false. Rebuilt here as an explicit line
// mesh because PlayCanvas has no wireframe-plane primitive.
import * as pc from 'playcanvas';
import { H_BASE, H_BASE2 } from './EditorScene';

// MainScene builds a 15x15-cell Plane(7500, 7500) for an empty level. Real
// maps are far larger (duel spans ~5000 units, berlin more), so the editor grid
// is extended to stay useful when a map is open; the cell size is unchanged.
const CELLS = 40;
const SIZE = CELLS * H_BASE2;

export function createGrid(app: pc.AppBase): pc.Entity {
  const positions: number[] = [];
  const half = SIZE / 2;

  for (let i = 0; i <= CELLS; i++) {
    const offset = -half + i * H_BASE2;
    // Lines along Y, then along X — flat on the sim ground plane (z = 0).
    positions.push(offset, -half, 0, offset, half, 0);
    positions.push(-half, offset, 0, half, offset, 0);
  }

  const mesh = new pc.Mesh(app.graphicsDevice);
  mesh.setPositions(positions);
  mesh.update(pc.PRIMITIVE_LINES);

  // Unlit, like every other material in this project (textures are pre-lit).
  const material = new pc.StandardMaterial();
  material.diffuse = new pc.Color(0, 0, 0);
  material.emissive = new pc.Color(0.12, 0.12, 0.12);
  material.useLighting = false;
  material.update();

  const entity = new pc.Entity('grid');
  entity.addComponent('render', {
    meshInstances: [new pc.MeshInstance(mesh, material)],
    castShadows: false,
    receiveShadows: false,
  });
  // MainScene offsets the grid by +hBase so its lines fall on cell boundaries
  // while single-cell props sit at cell centres.
  entity.setLocalPosition(H_BASE, H_BASE, 0);
  return entity;
}
