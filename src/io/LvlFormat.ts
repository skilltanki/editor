// Port of the original editor's BinaryExporter and
// BinaryImporter — the editor's native .lvl
// format (File -> Open / Save, as opposed to the Tanks map XML).
//
// Record layout, straight from BinaryExporter.exportToFileStream. No header,
// no count, no version: records run until EOF.
//
//   UTF    library        (uint16 byte length + UTF-8 bytes)
//   UTF    group
//   UTF    name
//   float  x              (32-bit)
//   float  y
//   float  z
//   float  rotationZ      (radians)
//   bool   free           (1 byte, 0 or 1)
//   UTF    textureName    ("" for non-tiles)
//
// BIG-ENDIAN throughout: AS3's FileStream defaults to Endian.BIG_ENDIAN and
// the editor never changes it. (Parser3DS, by contrast, explicitly selected
// LITTLE_ENDIAN — do not carry that assumption over.)
//
// Differences from the original, and why:
//   - FileStream becomes ArrayBuffer in / Uint8Array out; the browser has no
//     AIR file API.
//   - The original wrote `mirror` only in commented-out code
//     (BinaryExporter.as:38, BinaryImporter.as:52). Those lines stay dormant
//     here too, so the byte layout matches what the AS3 build actually
//     produced and existing .lvl files keep loading.
//   - Spawn points, bonus regions and CTF flags are recovered from the
//     synthetic "Functional" library this port writes for them. The original
//     resolved every record through LibraryManager.nameProp, which required a
//     real props library called "Functional"; that library does not exist in
//     this asset set, so such records would resolve to nothing and be dropped
//     (the same gap TanksXmlImporter works around).
//   - A record naming a prop that no library provides is skipped and counted
//     rather than aborting the parse. The original showed a modal
//     ("Library '...' is used by the level. Load?") and bailed out mid-file,
//     and its resume path was dead code (FileImporter.libAlertListener's YES
//     branch is commented out).
import { Prop, PropKind } from '../prop/Prop';

/** AS3 writeUTF: uint16 BYTE length (not code units) + UTF-8 bytes. */
class Writer {
  private chunks: Uint8Array[] = [];
  private scratch = new DataView(new ArrayBuffer(4));
  private encoder = new TextEncoder();

  utf(value: string): void {
    const bytes = this.encoder.encode(value);
    if (bytes.length > 0xffff) {
      throw new RangeError(`writeUTF: string too long (${bytes.length} bytes)`);
    }
    const header = new Uint8Array(2);
    new DataView(header.buffer).setUint16(0, bytes.length, false);
    this.chunks.push(header, bytes);
  }

  float(value: number): void {
    this.scratch.setFloat32(0, value, false);
    this.chunks.push(new Uint8Array(this.scratch.buffer.slice(0, 4)));
  }

  bool(value: boolean): void {
    this.chunks.push(new Uint8Array([value ? 1 : 0]));
  }

  toUint8Array(): Uint8Array<ArrayBuffer> {
    let length = 0;
    for (const chunk of this.chunks) {
      length += chunk.length;
    }
    const out = new Uint8Array(new ArrayBuffer(length));
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** Raised when a record runs past the end of the file. */
class Truncated extends Error {}

class Reader {
  private view: DataView;
  private offset = 0;
  private decoder = new TextDecoder();

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  get bytesAvailable(): number {
    return this.view.byteLength - this.offset;
  }

  utf(): string {
    this.require(2);
    const length = this.view.getUint16(this.offset, false);
    this.offset += 2;
    this.require(length);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    return this.decoder.decode(bytes);
  }

  float(): number {
    this.require(4);
    const value = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return value;
  }

  bool(): boolean {
    this.require(1);
    return this.view.getUint8(this.offset++) !== 0;
  }

  /** Throws Truncated so importLvl can stop cleanly on a short file. */
  private require(bytes: number): void {
    if (this.offset + bytes > this.view.byteLength) {
      throw new Truncated();
    }
  }
}

/** BinaryExporter.exportToFileStream */
export function exportLvl(props: Iterable<Prop>): Uint8Array<ArrayBuffer> {
  const writer = new Writer();
  for (const prop of props) {
    writer.utf(prop.library);
    writer.utf(prop.group);
    writer.utf(prop.name);
    writer.float(prop.x);
    writer.float(prop.y);
    writer.float(prop.z);
    writer.float(prop.rotationZ);
    writer.bool(prop.free);
    // Only tiles carry a texture name; everything else writes "".
    writer.utf(prop.kind === 'tile' ? prop.textureName : '');
  }
  return writer.toUint8Array();
}

export interface LvlImportResult {
  props: Prop[];
  /** Records whose library/group/name resolved to no known prop. */
  skipped: number;
  /** True when the file ended mid-record; whatever parsed is still returned. */
  truncated: boolean;
}

export interface LvlResolver {
  /** Same contract as TanksXmlImporter's resolveTile. */
  (library: string, group: string, name: string):
    { kind: PropKind; positions?: number[] | null } | null;
}

/**
 * Spawn/bonus/flag records carry the synthetic library this port writes for
 * them (see TanksXmlImporter), so their kind comes from the group name rather
 * than from a props library.
 */
function functionalKind(
  library: string,
  group: string,
): { kind: PropKind; positions?: number[] | null } | null {
  if (library !== 'Functional') {
    return null;
  }
  switch (group) {
    case 'Spawn Points': return { kind: 'spawn' };
    case 'Bonus Regions': return { kind: 'bonus' };
    case 'Flags': return { kind: 'flag' };
    default: return null;
  }
}

/** BinaryImporter.importFromFileStream */
export function importLvl(buffer: ArrayBuffer, resolve: LvlResolver): LvlImportResult {
  const reader = new Reader(buffer);
  const props: Prop[] = [];
  let skipped = 0;

  // A record is 3 strings + 4 floats + 1 bool + 1 string, so the smallest
  // possible one is 4*2 (empty strings) + 17 = 25 bytes. Longer strings can
  // still overrun a damaged file, so every read is bounds-checked and a short
  // tail ends the parse with whatever was recovered.
  let truncated = false;
  while (reader.bytesAvailable >= 25) {
    try {
      const library = reader.utf();
      const group = reader.utf();
      const name = reader.utf();
      const x = reader.float();
      const y = reader.float();
      const z = reader.float();
      const rotationZ = reader.float();
      const free = reader.bool();
      const textureName = reader.utf();

      const resolved = resolve(library, group, name) ?? functionalKind(library, group);
      if (resolved == null) {
        skipped++;
        continue;
      }
      const prop = new Prop({
        kind: resolved.kind,
        library,
        group,
        name,
        positions: resolved.positions,
      });
      prop.x = x;
      prop.y = y;
      prop.z = z;
      prop.rotationZ = rotationZ;
      prop.free = free;
      if (prop.kind === 'tile' && textureName !== '') {
        prop.textureName = textureName;
      }
      props.push(prop);
    } catch (error) {
      if (error instanceof Truncated) {
        truncated = true;
        break;
      }
      throw error;
    }
  }

  return { props, skipped, truncated };
}
