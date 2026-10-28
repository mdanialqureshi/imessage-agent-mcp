// Reads and writes Finder's .DS_Store files, just enough for the disk image window: Finder
// writes the layout, and the build keeps only the records it needs (see build-app.mjs).
//
// The format: a "buddy allocator" (header, then a root block listing every block's address)
// holding a B-tree of records. Each record is a file name, a 4-character code and a typed value.

const TYPES = { long: 4, shor: 4, bool: 1, type: 4, comp: 8, dutc: 8 };

/** The records in a .DS_Store file, in order: { name, code, type, value } (value is a Buffer). */
export function readDsStore(buf) {
  if (buf.readUInt32BE(0) !== 1 || buf.toString('latin1', 4, 8) !== 'Bud1') throw new Error('not a .DS_Store file');
  // Offsets inside the allocator are relative to byte 4.
  const at = (offset) => offset + 4;
  const rootOffset = buf.readUInt32BE(8);
  let p = at(rootOffset);
  const count = buf.readUInt32BE(p);
  p += 8;
  const addresses = [];
  for (let i = 0; i < count; i++) addresses.push(buf.readUInt32BE(p + i * 4));
  p += Math.ceil(count / 256) * 256 * 4;
  const toc = {};
  const entries = buf.readUInt32BE(p);
  p += 4;
  for (let i = 0; i < entries; i++) {
    const len = buf[p];
    const name = buf.toString('latin1', p + 1, p + 1 + len);
    toc[name] = buf.readUInt32BE(p + 1 + len);
    p += 5 + len;
  }
  const block = (id) => at(addresses[id] & ~0x1f);
  if (toc.DSDB === undefined) throw new Error('.DS_Store has no DSDB');
  const rootNode = buf.readUInt32BE(block(toc.DSDB));

  const records = [];
  const readRecord = (q) => {
    const nameLen = buf.readUInt32BE(q);
    const name = buf.subarray(q + 4, q + 4 + nameLen * 2).swap16().toString('utf16le');
    buf.subarray(q + 4, q + 4 + nameLen * 2).swap16(); // Swap back: subarray shares memory.
    q += 4 + nameLen * 2;
    const code = buf.toString('latin1', q, q + 4);
    const type = buf.toString('latin1', q + 4, q + 8);
    q += 8;
    let size = TYPES[type];
    if (type === 'blob') size = 4 + buf.readUInt32BE(q);
    else if (type === 'ustr') size = 4 + buf.readUInt32BE(q) * 2;
    if (size === undefined) throw new Error(`.DS_Store record type ${type} isn't supported`);
    records.push({ name, code, type, value: Buffer.from(buf.subarray(q, q + size)) });
    return q + size;
  };
  const readNode = (id, depth) => {
    if (depth > 16) throw new Error('.DS_Store tree is too deep');
    let q = block(id);
    const next = buf.readUInt32BE(q);
    const n = buf.readUInt32BE(q + 4);
    q += 8;
    for (let i = 0; i < n; i++) {
      if (next) {
        readNode(buf.readUInt32BE(q), depth + 1);
        q += 4;
      }
      q = readRecord(q);
    }
    if (next) readNode(next, depth + 1);
  };
  readNode(rootNode, 0);
  return records;
}

/** A .DS_Store file holding these records in a single leaf node, as Finder lays them out. */
export function writeDsStore(records) {
  const sorted = [...records].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const encoded = sorted.map(({ name, code, type, value }) => {
    const nameBuf = Buffer.from(name, 'utf16le').swap16();
    const len = Buffer.alloc(4);
    len.writeUInt32BE(name.length);
    return Buffer.concat([len, nameBuf, Buffer.from(code + type, 'latin1'), value]);
  });
  const head = Buffer.alloc(8);
  head.writeUInt32BE(0, 0); // A leaf.
  head.writeUInt32BE(encoded.length, 4);
  const node = Buffer.concat([head, ...encoded]);

  // A buddy allocator over 2^31 bytes: each allocation splits the smallest free block that fits.
  const free = Array.from({ length: 32 }, () => []);
  free[31].push(0);
  const alloc = (bytes) => {
    const width = Math.max(5, Math.ceil(Math.log2(bytes)));
    let j = width;
    while (!free[j].length) j++;
    const offset = free[j].shift();
    while (j > width) {
      j--;
      free[j].push(offset + 2 ** j);
      free[j].sort((a, b) => a - b);
    }
    return { offset, width };
  };
  alloc(32); // The header.
  const rootBlock = alloc(2048);
  const dsdb = alloc(20);
  const leaf = alloc(Math.max(4096, node.length));
  const address = (b) => b.offset | b.width;

  const dsdbBuf = Buffer.alloc(20);
  dsdbBuf.writeUInt32BE(2, 0); // The leaf is block 2.
  dsdbBuf.writeUInt32BE(0, 4); // Levels below the root.
  dsdbBuf.writeUInt32BE(encoded.length, 8);
  dsdbBuf.writeUInt32BE(1, 12); // Nodes.
  dsdbBuf.writeUInt32BE(0x1000, 16); // Page size.

  const parts = [];
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    parts.push(b);
  };
  const blocks = [rootBlock, dsdb, leaf];
  u32(blocks.length);
  u32(0);
  for (let i = 0; i < 256; i++) u32(i < blocks.length ? address(blocks[i]) : 0);
  u32(1); // One table-of-contents entry: DSDB is block 1.
  parts.push(Buffer.from([4]), Buffer.from('DSDB', 'latin1'));
  u32(1);
  for (const list of free) {
    u32(list.length);
    for (const offset of list) u32(offset);
  }
  const root = Buffer.concat(parts);
  if (root.length > 2048) throw new Error('.DS_Store root block overflow');

  const size = leaf.offset + 2 ** leaf.width + 4;
  const out = Buffer.alloc(size);
  out.writeUInt32BE(1, 0);
  out.write('Bud1', 4, 'latin1');
  out.writeUInt32BE(rootBlock.offset, 8);
  out.writeUInt32BE(2048, 12);
  out.writeUInt32BE(rootBlock.offset, 16);
  Buffer.from('0000100c000000000000000000000000', 'hex').copy(out, 20);
  root.copy(out, rootBlock.offset + 4);
  dsdbBuf.copy(out, dsdb.offset + 4);
  node.copy(out, leaf.offset + 4);
  return out;
}
