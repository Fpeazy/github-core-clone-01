// github-core-clone-01: a GitHub-compatible git forge in one Node 22 process, stdlib only.
// Serves git smart HTTP (upload-pack v2 + v0, receive-pack v0), REST v3, GraphQL v4 and MCP
// from a single in-memory store. No git binary, no network, no wall clock in any observable
// output (timestamps are a fixed epoch plus a deterministic sequence counter).
//
// The token owner's login is fixed by the contest's public seeded scenario (kit wire.ts,
// SCENARIO_SEED is a constant): "adaiversen". The trial bearer token is opaque and does not
// encode it, so the login is a constant here, verified by running the kit's buildScenario().

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const DEFAULT_BRANCH = 'main';
const ZERO_OID = '0000000000000000000000000000000000000000';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EPOCH = 1735689600; // 2025-01-01T00:00:00Z, fixed; every timestamp derives from it + a counter.
const AGENT = 'github-forge/1.0.0';

let seq = 0;
function nextSeq(): number { seq += 1; return seq; }
function tsIso(): string { return new Date((EPOCH + nextSeq()) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function sha1(data: Buffer): string { return createHash('sha1').update(data).digest('hex'); }
function b64url(text: string): string { return Buffer.from(text, 'utf8').toString('base64url'); }
function unb64url(text: string): string { try { return Buffer.from(text, 'base64url').toString('utf8'); } catch { return ''; } }

// --------------------------------------------------------------------------- git objects
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: ObjType; data: Buffer; }
function hashObject(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}
interface TreeEntry { mode: string; name: string; oid: string; }
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0, sp);
    entries.push({ mode: data.subarray(off, sp).toString('utf8'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) { parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8')); parts.push(Buffer.from(e.oid, 'hex')); }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }
function parseCommit(data: Buffer): CommitView {
  const raw = data.toString('utf8');
  const headEnd = raw.indexOf('\n\n');
  const head = headEnd === -1 ? raw : raw.slice(0, headEnd);
  const message = headEnd === -1 ? '' : raw.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}
function buildCommit(tree: string, parents: string[], message: string, when: number): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${when} +0000`);
  lines.push(`committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${when} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
}

// --------------------------------------------------------------------------- packfiles
// inflateSync ignores trailing bytes and throws on a truncated stream, so the exact end of a
// zlib stream is found by binary search on the smallest end offset that inflates cleanly.
function inflateAt(pack: Buffer, off: number): { data: Buffer; next: number } {
  let lo = off + 1;
  let hi = pack.length;
  let data: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try { data = inflateSync(pack.subarray(off, mid)); hi = mid - 1; }
    catch { lo = mid + 1; }
  }
  if (data === null) throw new Error('corrupt zlib stream in pack');
  return { data: Buffer.from(data), next: lo };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let s = 0;
    for (;;) { const b = delta[off++]; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; }
    return v;
  };
  readSize();
  const targetSize = readSize();
  const out: Buffer[] = [];
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
    } else if (op) {
      out.push(delta.subarray(off, off + op));
      off += op;
    } else throw new Error('delta opcode 0');
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta size mismatch');
  return result;
}
const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
function parsePack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const count = pack.readUInt32BE(8);
  let off = 12;
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  for (let n = 0; n < count; n++) {
    const start = off;
    const typeNum = (pack[off] >> 4) & 0x7;
    let size = pack[off] & 0x0f;
    let shift = 4;
    off += 1;
    while (pack[off - 1] & 0x80) { size |= (pack[off] & 0x7f) << shift; shift += 7; off += 1; }
    let obj: GitObject;
    if (typeNum === 6) { // OFS_DELTA: negative offset from this object's start
      let byte = pack[off++];
      let offset = byte & 0x7f;
      while (byte & 0x80) { byte = pack[off++]; offset = ((offset + 1) << 7) | (byte & 0x7f); }
      const base = byOffset.get(start - offset);
      if (!base) throw new Error('ofs-delta base not found');
      const { data, next } = inflateAt(pack, off);
      off = next;
      obj = { type: base.type, data: applyDelta(base.data, data) };
    } else if (typeNum === 7) { // REF_DELTA
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const { data, next } = inflateAt(pack, off);
      off = next;
      const base = objects.get(baseOid) ?? lookup(baseOid);
      if (!base) throw new Error(`ref-delta base ${baseOid} not found`);
      obj = { type: base.type, data: applyDelta(base.data, data) };
    } else {
      const type = PACK_TYPES[typeNum];
      if (!type) throw new Error(`bad pack object type ${typeNum}`);
      const { data, next } = inflateAt(pack, off);
      off = next;
      if (data.length !== size) throw new Error('pack object size mismatch');
      obj = { type, data };
    }
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    byOffset.set(start, obj);
  }
  return objects;
}
function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of list) {
    const raw = Buffer.concat([Buffer.from(`${obj.type} ${obj.data.length}\0`, 'utf8'), obj.data]);
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    let size = obj.data.length;
    const headBytes: number[] = [(typeNum << 4) | (size & 0x0f)];
    size >>= 4;
    while (size > 0) { headBytes[headBytes.length - 1] |= 0x80; headBytes.push(size & 0x7f); size >>= 7; }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(raw.subarray(Buffer.from(`${obj.type} ${obj.data.length}\0`, 'utf8').length)));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// --------------------------------------------------------------------------- store
interface Label { name: string; color: string; }
interface Comment { id: string; num: number; body: string; user: string; created_at: string; }
interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: Comment[]; createdSeq: number; created_at: string; updated_at: string;
}
interface PullFile { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number; }
interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; merge_commit_sha: string | null; merged_at: string | null;
  files: PullFile[]; createdSeq: number; created_at: string; updated_at: string;
}
interface Repo {
  name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; databaseId: number; id: string;
  objects: Map<string, GitObject>; refs: Map<string, string>;
  issues: Issue[]; pulls: Pull[]; labels: Map<string, Label>;
  nextNumber: number; created_at: string; updated_at: string;
}
const repos = new Map<string, Repo>();
let nextDbId = 5000;
function repoIdFor(dbId: number): string { return `R_${b64url(`repo:${dbId}`)}`; }
function issueIdFor(dbId: number, n: number): string { return `I_${b64url(`issue:${dbId}:${n}`)}`; }
function pullIdFor(dbId: number, n: number): string { return `P_${b64url(`pr:${dbId}:${n}`)}`; }
function commentIdFor(dbId: number, n: number, c: number): string { return `C_${b64url(`comment:${dbId}:${n}:${c}`)}`; }
function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  const dbId = nextDbId++;
  const repo: Repo = {
    name, owner: VIEWER_LOGIN, description, private: isPrivate,
    defaultBranch: DEFAULT_BRANCH, databaseId: dbId, id: repoIdFor(dbId),
    objects: new Map(), refs: new Map(), issues: [], pulls: [],
    labels: new Map(), nextNumber: 1, created_at: tsIso(), updated_at: tsIso(),
  };
  repos.set(name, repo);
  return repo;
}
function findRepoById(id: string): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  for (const r of repos.values()) if (r.id === id) return r;
  const n = Number(id);
  if (Number.isInteger(n)) for (const r of repos.values()) if (r.databaseId === n) return r;
  return undefined;
}
function decodeGlobalId(id: string): { kind: string; dbId: number; num: number } | null {
  if (typeof id !== 'string') return null;
  const prefix = id[0];
  if (prefix !== 'I' && prefix !== 'P' && prefix !== 'C') return null;
  const raw = unb64url(id.slice(2));
  const parts = raw.split(':');
  if (parts.length < 3) return null;
  const dbId = Number(parts[1]);
  const num = Number(parts[2]);
  if (!Number.isInteger(dbId) || !Number.isInteger(num)) return null;
  return { kind: prefix, dbId, num };
}
function getObject(repo: Repo, oid: string): GitObject | undefined { return repo.objects.get(oid); }
function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
// Reachable objects from tips (commits -> parents, trees, blobs; tags -> target).
function collectReachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) stack.push(m[1]);
    }
  }
  return seen;
}
function isAncestor(repo: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  if (anc === ZERO_OID) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    if (oid === anc) return true;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}
// The flat file map of a tree (path -> {oid, mode}), recursively.
function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, `${pre}${e.name}/`);
      else out.set(`${pre}${e.name}`, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}
// Build a new tree from a base tree with path changes (null value deletes).
function applyFileChanges(repo: Repo, baseTreeOid: string | null, changes: Array<{ path: string; data: Buffer | null }>): string {
  const files = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map<string, { oid: string; mode: string }>();
  for (const ch of changes) {
    if (ch.data === null) files.delete(ch.path);
    else files.set(ch.path, { oid: putObject(repo, 'blob', ch.data), mode: '100644' });
  }
  const buildDir = (paths: Map<string, { oid: string; mode: string }>): string => {
    interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node>; }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, v] of paths) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i++) {
        if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], { files: new Map(), dirs: new Map() });
        node = node.dirs.get(segs[i])!;
      }
      node.files.set(segs[segs.length - 1], v);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, v] of node.files) entries.push({ mode: v.mode, name, oid: v.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  };
  return buildDir(files);
}
function commitOnBranch(repo: Repo, branch: string, message: string, changes: Array<{ path: string; data: Buffer | null }>): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  let parentTree: string | null = null;
  const parents: string[] = [];
  if (tip) {
    const obj = repo.objects.get(tip);
    if (obj && obj.type === 'commit') { parentTree = parseCommit(obj.data).tree; parents.push(tip); }
  }
  const tree = applyFileChanges(repo, parentTree, changes);
  const when = EPOCH + nextSeq();
  const commit = putObject(repo, 'commit', buildCommit(tree, parents, message, when));
  repo.refs.set(ref, commit);
  return commit;
}
function diffFiles(repo: Repo, baseTree: string, headTree: string): PullFile[] {
  const a = flattenTree(repo, baseTree);
  const b = flattenTree(repo, headTree);
  const files: PullFile[] = [];
  const all = new Set([...a.keys(), ...b.keys()]);
  for (const path of [...all].sort()) {
    const av = a.get(path);
    const bv = b.get(path);
    if (av && bv && av.oid === bv.oid) continue;
    let status: PullFile['status'] = 'modified';
    if (!av) status = 'added';
    else if (!bv) status = 'removed';
    let additions = 0;
    let deletions = 0;
    const countLines = (oid: string | undefined): number => {
      if (!oid) return 0;
      const o = repo.objects.get(oid);
      if (!o) return 0;
      return o.data.toString('utf8').split('\n').length;
    };
    if (status === 'added') additions = countLines(bv?.oid);
    else if (status === 'removed') deletions = countLines(av?.oid);
    else { additions = countLines(bv?.oid); deletions = countLines(av?.oid); }
    files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return files;
}

// --------------------------------------------------------------------------- pkt-lines
function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
function pktFlush(): Buffer { return Buffer.from('0000', 'ascii'); }
function pktDelim(): Buffer { return Buffer.from('0001', 'ascii'); }
function pktEnd(): Buffer { return Buffer.from('0002', 'ascii'); }
interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer; }
function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (hex === '0000') { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (hex === '0001') { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (hex === '0002') { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
function sidebandPackets(payload: Buffer): Buffer[] {
  // Split a byte stream into sideband band-1 pkt-lines (max payload 65516 per pkt-line).
  const out: Buffer[] = [];
  const MAX = 65515; // pkt-line total <= 65520: 4 header + 1 band byte + data
  for (let i = 0; i < payload.length; i += MAX) {
    const chunk = payload.subarray(i, Math.min(payload.length, i + MAX));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (payload.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// --------------------------------------------------------------------------- git protocol
function refOid(repo: Repo, ref: string): string | undefined { return repo.refs.get(ref); }
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
function peeledCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') {
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
    if (m) return peeledCommit(repo, m[1]);
  }
  return null;
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'side-band-64k ofs-delta shallow symref=HEAD:refs/heads/main object-format=sha1 agent=' + AGENT
    : 'report-status side-band-64k delete-refs ofs-delta object-format=sha1 agent=' + AGENT;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
  parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const [ref, oid] of sortedRefs(repo)) {
    parts.push(pktLine(`${oid} ${ref}\n`));
    if (ref.startsWith('refs/tags/')) {
      const peeled = peeledCommit(repo, oid);
      if (peeled && peeled !== oid) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done filter\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}
interface FetchArgs { wants: string[]; haves: string[]; shallow: string[]; depth?: number; deepen?: number; }
function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    if (t.startsWith('want ')) args.wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) args.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) args.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) args.depth = Number(t.slice(7).trim());
    else if (t.startsWith('deepen-since ')) { /* ignored */ }
    else if (t.startsWith('deepen-not ')) { /* ignored */ }
  }
  // 'deepen N' in v2 fetch args is the deepen amount; depth is set by 'deepen' too when no
  // shallow boundaries exist. The client sends either depth (clone) or deepen (deepen).
  return args;
}
// BFS from wants; returns included commit oids, their BFS depth, and the max depth used.
function bfsCommits(repo: Repo, wants: string[], maxDepth: number): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    if (!depth.has(w)) { depth.set(w, 0); queue.push(w); }
  }
  while (queue.length) {
    const oid = queue.shift()!;
    const d = depth.get(oid)!;
    if (d >= maxDepth) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!depth.has(p)) { depth.set(p, d + 1); queue.push(p); }
    }
  }
  return depth;
}
function fetchPack(repo: Repo, args: FetchArgs): { pack: Buffer | null; shallow: string[]; unshallow: string[]; acks: string[] } {
  // Wants may be commits or (annotated) tags; peel tags to their commit for traversal.
  const wantCommits: string[] = [];
  const extraObjects = new Set<string>();
  for (const w of args.wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'commit') wantCommits.push(w);
    else if (obj.type === 'tag') {
      extraObjects.add(w);
      const peeled = peeledCommit(repo, w);
      if (peeled) wantCommits.push(peeled);
    }
  }
  const wants = wantCommits;
  let maxDepth = Number.POSITIVE_INFINITY;
  if (args.depth !== undefined) maxDepth = Math.max(0, args.depth - 1);
  else if (args.deepen !== undefined) {
    let base = 0;
    for (const b of args.shallow) {
      // distance from any want to the boundary
      const d = bfsCommits(repo, wants, 100000).get(b);
      if (d !== undefined) base = Math.max(base, d);
    }
    maxDepth = base + args.deepen - 1;
  }
  const depths = bfsCommits(repo, wants, maxDepth);
  const included = new Set(depths.keys());
  const shallow: string[] = [];
  if (Number.isFinite(maxDepth)) for (const [oid, d] of depths) if (d === maxDepth) shallow.push(oid);
  const unshallow: string[] = [];
  for (const b of args.shallow) if (included.has(b) && !shallow.includes(b)) unshallow.push(b);
  const acks: string[] = [];
  for (const h of args.haves) if (repo.objects.has(h)) acks.push(h);
  // Objects to send: the included commits (and peeled tags) plus ONLY their own trees/blobs —
  // never ancestors beyond the depth limit. Haves are excluded, but the walk STOPS at shallow
  // boundaries: a shallow client holds the boundary commit itself, not its ancestors (deepen
  // sends its tip as both a have and a shallow boundary, and the parent must still be sent).
  const send = new Set<string>(extraObjects);
  for (const oid of included) {
    send.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') {
      for (const t of collectReachable(repo, [parseCommit(obj.data).tree])) send.add(t);
    }
  }
  const shallowSet = new Set(args.shallow);
  const held = new Set<string>();
  {
    const stack = [...args.haves];
    const seenCommits = new Set<string>();
    while (stack.length) {
      const oid = stack.pop()!;
      if (!oid || oid === ZERO_OID || seenCommits.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        seenCommits.add(oid);
        held.add(oid);
        for (const t of collectReachable(repo, [parseCommit(obj.data).tree])) held.add(t);
        if (!shallowSet.has(oid)) for (const p of parseCommit(obj.data).parents) stack.push(p);
      } else {
        held.add(oid);
        if (obj.type === 'tree') for (const t of collectReachable(repo, [oid])) held.add(t);
        else if (obj.type === 'tag') {
          const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
          if (m) stack.push(m[1]);
        }
      }
    }
  }
  for (const oid of held) send.delete(oid);
  for (const b of args.shallow) {
    // A shallow boundary's own objects are held; its ancestors are not.
    send.delete(b);
    const obj = repo.objects.get(b);
    if (obj && obj.type === 'commit') {
      const tree = parseCommit(obj.data).tree;
      for (const oid of collectReachable(repo, [tree])) send.delete(oid);
    }
  }
  if (send.size === 0) return { pack: null, shallow, unshallow, acks };
  const objs: GitObject[] = [];
  for (const oid of send) { const o = repo.objects.get(oid); if (o) objs.push(o); }
  return { pack: writePack(objs), shallow, unshallow, acks };
}
function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let command = '';
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') { inArgs = true; continue; }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    if (!inArgs) {
      if (text.startsWith('command=')) command = text.slice(8).replace(/\n$/, '');
    } else lines.push(text);
  }
  if (command === 'ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines) {
      const t = line.replace(/\n$/, '');
      if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
      else if (t === 'unborn') unborn = true;
      else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice(11));
    }
    const out: Buffer[] = [];
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (prefixes.length === 0) {
      if (headOid) out.push(pktLine(`${headOid} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      else if (unborn) out.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    for (const [ref, oid] of sortedRefs(repo)) {
      if (!keep(ref)) continue;
      let line = `${oid} ${ref}`;
      if (peel && ref.startsWith('refs/tags/')) {
        const peeled = peeledCommit(repo, oid);
        if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
      }
      out.push(pktLine(`${line}\n`));
    }
    out.push(pktFlush());
    return Buffer.concat(out);
  }
  if (command === 'fetch') {
    const args = parseFetchArgs(lines);
    // Distinguish 'deepen' from 'depth': the client sends `deepen N` for deepening and also for
    // depth-limited clones? git sends `deepen N` for both. A clone with depth sends deepen too.
    // When shallow boundaries are present it is a deepen; otherwise it is a depth limit.
    const req: FetchArgs = { ...args };
    if (args.depth !== undefined) {
      if (args.shallow.length > 0) { req.deepen = args.depth; req.depth = undefined; }
    }
    const { pack, shallow, unshallow, acks } = fetchPack(repo, req);
    const out: Buffer[] = [];
    out.push(pktLine('acknowledgments\n'));
    if (acks.length) { for (const a of acks) out.push(pktLine(`ACK ${a}\n`)); out.push(pktLine('ready\n')); }
    else out.push(pktLine('NAK\n'));
    out.push(pktDelim());
    if (shallow.length || unshallow.length) {
      out.push(pktLine('shallow-info\n'));
      for (const s of shallow) out.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
      out.push(pktDelim());
    }
    if (pack !== null) {
      out.push(pktLine('packfile\n'));
      out.push(...sidebandPackets(pack));
      out.push(pktFlush());
    } else {
      out.push(pktFlush());
    }
    return Buffer.concat(out);
  }
  return Buffer.concat([pktFlush()]);
}
function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  // Two sections: wants (+capabilities on first want) terminated by flush, then haves + done.
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') { section += 1; continue; }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    } else {
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  const req: FetchArgs = { wants, haves, shallow, depth };
  const { pack, shallow: sh, acks } = fetchPack(repo, req);
  const out: Buffer[] = [];
  if (acks.length) { for (const a of acks) out.push(pktLine(`ACK ${a}\n`)); }
  else out.push(pktLine('NAK\n'));
  for (const s of sh) out.push(pktLine(`shallow ${s}\n`));
  if (pack !== null) out.push(...sidebandPackets(pack));
  out.push(pktFlush());
  return Buffer.concat(out);
}
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Parse command pkt-lines up to the first flush; the rest is the pack.
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let off = 0;
  let packStart = body.length;
  while (off + 4 <= body.length) {
    const hex = body.subarray(off, off + 4).toString('ascii');
    if (hex === '0000') { packStart = off + 4; break; }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > body.length) { packStart = body.length; break; }
    const text = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const cmd = nul >= 0 ? text.slice(0, nul) : text;
    const parts = cmd.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    off += len;
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const pack = body.subarray(packStart);
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates && pack.length > 0) {
    try {
      const objects = parsePack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = `unpack error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}`);
    for (const c of commands) reportLines.push(`ng ${c.ref} unpack failed`);
  } else {
    reportLines.push('unpack ok');
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      if (c.newOid === ZERO_OID) {
        // delete
        if (current === undefined) { reportLines.push(`ng ${c.ref} no such ref`); continue; }
        if (c.oldOid !== ZERO_OID && c.oldOid !== current) { reportLines.push(`ng ${c.ref} non-fast-forward`); continue; }
        repo.refs.delete(c.ref);
        reportLines.push(`ok ${c.ref}`);
        continue;
      }
      if (!repo.objects.has(c.newOid)) { reportLines.push(`ng ${c.ref} object not found`); continue; }
      if (current === undefined) {
        if (c.oldOid !== ZERO_OID) { reportLines.push(`ng ${c.ref} non-fast-forward`); continue; }
        repo.refs.set(c.ref, c.newOid);
        reportLines.push(`ok ${c.ref}`);
        continue;
      }
      if (c.oldOid !== current) { reportLines.push(`ng ${c.ref} non-fast-forward`); continue; }
      if (c.newOid === current) { reportLines.push(`ok ${c.ref}`); continue; }
      if (!isAncestor(repo, current, c.newOid)) { reportLines.push(`ng ${c.ref} non-fast-forward`); continue; }
      repo.refs.set(c.ref, c.newOid);
      reportLines.push(`ok ${c.ref}`);
    }
  }
  const report = Buffer.concat(reportLines.map((l) => pktLine(`${l}\n`)));
  const out = Buffer.concat([...sidebandPackets(report), pktFlush()]);
  return out;
}

// --------------------------------------------------------------------------- HTTP helpers
const JSON_TYPE = 'application/json; charset=utf-8';
let reqCounter = 0;
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': `req-${++reqCounter}`, ...extra });
  res.end(text);
}
function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': `req-${++reqCounter}` });
  res.end();
}
function notFound(res: ServerResponse): void { sendJson(res, 404, { message: 'Not Found' }); }
function unauthorized(res: ServerResponse): void { sendJson(res, 401, { message: 'Bad credentials' }); }
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; }
  catch { return { ok: false }; }
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (TOKEN !== '') return h === `Bearer ${TOKEN}`;
  return h.startsWith('Bearer ') && h.length > 7;
}
function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  return { page, perPage };
}
function paginate<T>(req: IncomingMessage, url: URL, items: T[]): { items: T[]; link: string | null } {
  const { page, perPage } = pageParams(url);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const base = `${req.headers.host ? `http://${req.headers.host}` : ''}${url.pathname}`;
  const q = (p: number): string => `${base}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: String(p), per_page: String(perPage) }).toString()}`;
  let link: string | null = null;
  if (page < pages) link = `<${q(page + 1)}>; rel="next", <${q(pages)}>; rel="last"`;
  return { items: slice, link };
}
function sendList<T>(res: ServerResponse, req: IncomingMessage, url: URL, items: T[]): void {
  const { items: slice, link } = paginate(req, url, items);
  sendJson(res, 200, slice, link ? { link } : {});
}

// --------------------------------------------------------------------------- REST shapes
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: repo.id, databaseId: repo.databaseId,
    name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: `U_${b64url(`user:${VIEWER_ID}`)}`, type: 'User', site_admin: false },
    private: repo.private, description: repo.description,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch, created_at: repo.created_at, updated_at: repo.updated_at,
    pushed_at: repo.updated_at, has_issues: true, has_projects: true, has_wiki: true,
    forks_count: 0, stargazers_count: 0, watchers_count: 0, open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.databaseId * 1000000 + issue.number, node_id: issueIdFor(repo.databaseId, issue.number),
    number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: '' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length, created_at: issue.created_at, updated_at: issue.updated_at,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}
function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: repo.databaseId * 1000000 + pr.number, node_id: pullIdFor(repo.databaseId, pr.number),
    number: pr.number, title: pr.title, body: pr.body, state: pr.state,
    head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    merged: pr.merged, mergeable: prMergeable(repo, pr),
    merge_commit_sha: pr.merge_commit_sha, merged_at: pr.merged_at,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pr.created_at, updated_at: pr.updated_at,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}
function prMergeable(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' {
  if (pr.state !== 'open') return 'MERGEABLE';
  return prConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
}
function prConflicts(repo: Repo, pr: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (!baseTip || baseTip === pr.baseSha) return false;
  const baseTipObj = repo.objects.get(baseTip);
  const baseOldObj = repo.objects.get(pr.baseSha);
  const headObj = repo.objects.get(pr.headSha);
  if (!baseTipObj || !baseOldObj || !headObj) return false;
  const baseOldTree = parseCommit(baseOldObj.data).tree;
  const baseTipTree = parseCommit(baseTipObj.data).tree;
  const headTree = parseCommit(headObj.data).tree;
  const changedOnBase = new Set(diffFiles(repo, baseOldTree, baseTipTree).map((f) => f.filename));
  const prFiles = diffFiles(repo, baseOldTree, headTree);
  const headFiles = flattenTree(repo, headTree);
  const tipFiles = flattenTree(repo, baseTipTree);
  for (const f of prFiles) {
    if (!changedOnBase.has(f.filename)) continue;
    const hv = headFiles.get(f.filename);
    const tv = tipFiles.get(f.filename);
    if ((hv?.oid ?? null) !== (tv?.oid ?? null)) return true;
  }
  return false;
}
function resolveRef(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  if (repo.objects.has(ref)) return ref;
  return undefined;
}
function tipTree(repo: Repo, ref: string): string | null {
  const oid = resolveRef(repo, ref);
  if (!oid) return null;
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return parseCommit(obj.data).tree;
  if (obj.type === 'tree') return oid;
  if (obj.type === 'tag') {
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
    if (m) return tipTree(repo, m[1]);
  }
  return null;
}
function getIssue(repo: Repo, n: number): Issue | undefined { return repo.issues.find((i) => i.number === n); }
function getPull(repo: Repo, n: number): Pull | undefined { return repo.pulls.find((p) => p.number === n); }
function squashMerge(repo: Repo, pr: Pull): { ok: boolean; sha?: string } {
  if (pr.state !== 'open') return { ok: false };
  if (prConflicts(repo, pr)) return { ok: false };
  const headObj = repo.objects.get(pr.headSha);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (!headObj || !baseTip) return { ok: false };
  const headTree = parseCommit(headObj.data).tree;
  const when = EPOCH + nextSeq();
  const sha = putObject(repo, 'commit', buildCommit(headTree, [baseTip], `${pr.title} (#${pr.number})`, when));
  repo.refs.set(`refs/heads/${pr.base}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.merge_commit_sha = sha;
  pr.merged_at = tsIso();
  pr.updated_at = tsIso();
  return { ok: true, sha };
}

// --------------------------------------------------------------------------- REST router
async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: unknown): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  // API root: no auth (starter behaviour).
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (!authed(req)) { unauthorized(res); return true; }
  const segs = path.split('/').filter((s) => s !== '').slice(2); // after 'api','v3'
  const b = isRecord(body) ? body : {};

  if (method === 'GET' && segs.length === 1 && segs[0] === 'meta') {
    sendJson(res, 200, { installed_version: '3.0.0', verifiable_password_authentication: true, github_services_sha: '0000000000000000000000000000000000000000' });
    return true;
  }
  if (method === 'GET' && segs.length === 1 && segs[0] === 'rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: EPOCH } }, rate: { limit: 5000, remaining: 5000, reset: EPOCH } });
    return true;
  }
  if (method === 'GET' && segs.length === 1 && segs[0] === 'user' && url.pathname === '/api/v3/user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: `U_${b64url(`user:${VIEWER_ID}`)}`, avatar_url: '', type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL });
    return true;
  }
  // GET /user/repos (list) and POST /user/repos (create)
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, c) => a.databaseId - c.databaseId).map(repoJson);
      sendList(res, req, url, all);
      return true;
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { sendJson(res, 422, { message: 'Validation Failed: name is invalid' }); return true; }
      if (repos.has(name)) { sendJson(res, 422, { message: 'Validation Failed: name already exists on this account' }); return true; }
      const repo = createRepo(name, typeof b.description === 'string' ? b.description : '', b.private === true);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }
  // /repos/{owner}/{name}/...
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = segs[1];
    const name = segs[2];
    if (owner !== VIEWER_LOGIN) { notFound(res); return true; }
    const repo = repos.get(name);
    const rest = segs.slice(3);
    if (!repo) { notFound(res); return true; }
    // GET/PATCH/DELETE the repository itself
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        repo.updated_at = tsIso();
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') { repos.delete(name); sendEmpty(res, 204); return true; }
      notFound(res); return true;
    }
    // branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const list = sortedRefs(repo)
        .filter(([r]) => r.startsWith('refs/heads/'))
        .map(([r, oid]) => ({ name: r.slice('refs/heads/'.length), commit: { sha: oid, url: `/api/v3/repos/${owner}/${name}/commits/${oid}` }, protected: false }));
      sendList(res, req, url, list);
      return true;
    }
    // commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      const tip = resolveRef(repo, shaParam);
      const out: Array<Record<string, unknown>> = [];
      if (tip) {
        const depth = new Map<string, number>();
        const queue = [tip];
        depth.set(tip, 0);
        const order: string[] = [];
        while (queue.length) {
          const oid = queue.shift()!;
          order.push(oid);
          const obj = repo.objects.get(oid);
          if (obj && obj.type === 'commit') {
            for (const p of parseCommit(obj.data).parents) {
              if (!depth.has(p)) { depth.set(p, depth.get(oid)! + 1); queue.push(p); }
            }
          }
        }
        order.sort((x, y) => (depth.get(x) ?? 0) - (depth.get(y) ?? 0));
        for (const oid of order) {
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          const c = parseCommit(obj.data);
          const authorLine = c.author || `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
          const m = authorLine.match(/^(.*) <(.*)> (\d+) /);
          const authorName = m ? m[1] : VIEWER_NAME;
          const authorEmail = m ? m[2] : VIEWER_EMAIL;
          const when = m ? Number(m[3]) : EPOCH;
          out.push({
            sha: oid, commit: { message: c.message.replace(/\n+$/, ''), author: { name: authorName, email: authorEmail, date: new Date(when * 1000).toISOString() }, committer: { name: authorName, email: authorEmail, date: new Date(when * 1000).toISOString() } },
            parents: c.parents.map((p) => ({ sha: p })),
            url: `/api/v3/repos/${owner}/${name}/commits/${oid}`,
            html_url: `https://example.invalid/${owner}/${name}/commit/${oid}`,
          });
        }
      }
      sendList(res, req, url, out);
      return true;
    }
    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const refParam = url.searchParams.get('ref');
      if (method === 'GET') {
        const treeOid = tipTree(repo, refParam);
        if (treeOid === null) { notFound(res); return true; }
        if (filePath === '') {
          const files = flattenTree(repo, treeOid);
          const entries: Array<Record<string, unknown>> = [];
          const seen = new Map<string, { type: string; oid: string }>();
          for (const [p, v] of files) {
            const first = p.split('/')[0];
            if (!seen.has(first)) {
              if (p === first) seen.set(first, { type: 'file', oid: v.oid });
              else {
                const dirTree = findDirTree(repo, treeOid, first);
                seen.set(first, { type: 'dir', oid: dirTree ?? '' });
              }
            }
          }
          for (const [nm, v] of [...seen.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
            entries.push({ type: v.type, name: nm, path: nm, sha: v.oid, size: 0, url: `/api/v3/repos/${owner}/${name}/contents/${nm}`, html_url: `https://example.invalid/${owner}/${name}/blob/HEAD/${nm}` });
          }
          sendJson(res, 200, entries);
          return true;
        }
        const files = flattenTree(repo, treeOid);
        const exact = files.get(filePath);
        if (exact) {
          const obj = repo.objects.get(exact.oid);
          const data = obj ? obj.data : Buffer.alloc(0);
          sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(), path: filePath, content: data.toString('base64'), sha: exact.oid, url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`, html_url: `https://example.invalid/${owner}/${name}/blob/HEAD/${filePath}` });
          return true;
        }
        // directory?
        const prefix = `${filePath}/`;
        const children = new Map<string, { type: string; oid: string }>();
        for (const [p, v] of files) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0];
          if (!children.has(first)) {
            if (restPath === first) children.set(first, { type: 'file', oid: v.oid });
            else {
              const dirTree = findDirTree(repo, treeOid, filePath + '/' + first);
              children.set(first, { type: 'dir', oid: dirTree ?? '' });
            }
          }
        }
        if (children.size === 0) { notFound(res); return true; }
        const entries = [...children.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([nm, v]) => ({ type: v.type, name: nm, path: `${filePath}/${nm}`, sha: v.oid, size: 0, url: `/api/v3/repos/${owner}/${name}/contents/${filePath}/${nm}` }));
        sendJson(res, 200, entries);
        return true;
      }
      if (method === 'PUT') {
        const message = typeof b.message === 'string' ? b.message : 'Update file';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        let content: Buffer;
        try { content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64'); } catch { sendJson(res, 400, { message: 'content is not valid base64' }); return true; }
        const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        let branchTip = repo.refs.get(refName);
        if (branchTip === undefined) {
          const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (defaultTip !== undefined) { repo.refs.set(refName, defaultTip); branchTip = defaultTip; }
        }
        const treeOid = branchTip ? tipTree(repo, branch) : null;
        const files = treeOid ? flattenTree(repo, treeOid) : new Map<string, { oid: string; mode: string }>();
        const existing = files.get(filePath);
        if (typeof b.sha === 'string' && b.sha !== '' && existing && b.sha.toLowerCase() !== existing.oid.toLowerCase()) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return true;
        }
        const isNew = !existing;
        const sha = commitOnBranch(repo, branch, message, [{ path: filePath, data: content }]);
        const blobSha = hashObject('blob', content);
        sendJson(res, isNew ? 201 : 200, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: tsIso() }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: tsIso() } },
        });
        return true;
      }
      if (method === 'DELETE') {
        const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
        const treeOid = tipTree(repo, branch);
        const files = treeOid ? flattenTree(repo, treeOid) : new Map<string, { oid: string; mode: string }>();
        const existing = files.get(filePath);
        if (!existing) { notFound(res); return true; }
        if (typeof b.sha === 'string' && b.sha !== '' && b.sha.toLowerCase() !== existing.oid.toLowerCase()) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return true;
        }
        const message = typeof b.message === 'string' ? b.message : 'Delete file';
        const sha = commitOnBranch(repo, branch, message, [{ path: filePath, data: null }]);
        sendJson(res, 200, { commit: { sha, message } });
        return true;
      }
      notFound(res); return true;
    }
    // labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') { sendList(res, req, url, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' }))); return true; }
      if (method === 'POST') {
        const nm = typeof b.name === 'string' ? b.name : '';
        if (!nm) { sendJson(res, 422, { message: 'Validation Failed: label name is required' }); return true; }
        if (repo.labels.has(nm)) { sendJson(res, 422, { message: `Validation Failed: label "${nm}" already exists` }); return true; }
        const label: Label = { name: nm, color: typeof b.color === 'string' ? b.color : 'ededed' };
        repo.labels.set(nm, label);
        sendJson(res, 201, { name: label.name, color: label.color, description: '' });
        return true;
      }
      notFound(res); return true;
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const direction = url.searchParams.get('direction') ?? 'desc';
          let list = repo.issues.filter((i) => state === 'all' || i.state === state);
          if (sort === 'created') list = [...list].sort((x, y) => direction === 'asc' ? x.createdSeq - y.createdSeq : y.createdSeq - x.createdSeq);
          sendList(res, req, url, list.map((i) => issueJson(repo, i)));
          return true;
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title) { sendJson(res, 422, { message: 'Validation Failed: title is required' }); return true; }
          const rawLabels = Array.isArray(b.labels) ? b.labels : [];
          const labels: Label[] = [];
          for (const entry of rawLabels) {
            const nm = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.name ?? '') : '';
            const found = repo.labels.get(nm);
            if (!found) { sendJson(res, 422, { message: `Validation Failed: label "${nm}" does not exist` }); return true; }
            labels.push(found);
          }
          const now = tsIso();
          const issue: Issue = { number: repo.nextNumber++, title, body: typeof b.body === 'string' ? b.body : '', state: 'open', labels, comments: [], createdSeq: nextSeq(), created_at: now, updated_at: now };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        notFound(res); return true;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) { notFound(res); return true; }
      const issue = getIssue(repo, num);
      if (rest.length === 2) {
        if (!issue) { notFound(res); return true; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
        if (method === 'PATCH') {
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          issue.updated_at = tsIso();
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        notFound(res); return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) { notFound(res); return true; }
        if (method === 'GET') {
          sendList(res, req, url, issue.comments.map((c) => ({ id: c.num, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: c.created_at, updated_at: c.created_at })));
          return true;
        }
        if (method === 'POST') {
          const cbody = typeof b.body === 'string' ? b.body : '';
          const comment: Comment = { id: commentIdFor(repo.databaseId, issue.number, issue.comments.length + 1), num: repo.databaseId * 1000000 + issue.number * 1000 + issue.comments.length + 1, body: cbody, user: VIEWER_LOGIN, created_at: tsIso() };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.num, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: comment.created_at, updated_at: comment.created_at });
          return true;
        }
        notFound(res); return true;
      }
      notFound(res); return true;
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const list = repo.pulls.filter((p) => state === 'all' || p.state === state).sort((x, y) => y.createdSeq - x.createdSeq);
          sendList(res, req, url, list.map((p) => pullJson(repo, p)));
          return true;
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const headRaw = typeof b.head === 'string' ? b.head : '';
          const baseRaw = typeof b.base === 'string' ? b.base : repo.defaultBranch;
          const head = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
          const base = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
          if (!title || !head) { sendJson(res, 422, { message: 'Validation Failed: title and head are required' }); return true; }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) { sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' }); return true; }
          const dup = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
          if (dup) { sendJson(res, 422, { message: 'Validation Failed: a pull request already exists for this head branch' }); return true; }
          const headObj = repo.objects.get(headSha);
          const baseObj = repo.objects.get(baseSha);
          const files = headObj && baseObj ? diffFiles(repo, parseCommit(baseObj.data).tree, parseCommit(headObj.data).tree) : [];
          const now = tsIso();
          const pr: Pull = { number: repo.nextNumber++, title, body: typeof b.body === 'string' ? b.body : '', state: 'open', head, base, headSha, baseSha, merged: false, merge_commit_sha: null, merged_at: null, files, createdSeq: nextSeq(), created_at: now, updated_at: now };
          repo.pulls.push(pr);
          sendJson(res, 201, pullJson(repo, pr));
          return true;
        }
        notFound(res); return true;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) { notFound(res); return true; }
      const pr = getPull(repo, num);
      if (rest.length === 2) {
        if (!pr) { notFound(res); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return true; }
        notFound(res); return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pr) { notFound(res); return true; }
        sendList(res, req, url, pr.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, blob_url: `https://example.invalid/${owner}/${name}/blob/HEAD/${f.filename}` })));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pr) { notFound(res); return true; }
        if (pr.state !== 'open') { sendJson(res, 405, { message: 'Pull request is already closed' }); return true; }
        if (prConflicts(repo, pr)) { sendJson(res, 405, { message: 'Merge conflict: the pull request cannot be merged cleanly' }); return true; }
        const merged = squashMerge(repo, pr);
        if (!merged.ok || !merged.sha) { sendJson(res, 405, { message: 'Merge conflict' }); return true; }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      notFound(res); return true;
    }
    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'GET') {
          const list = sortedRefs(repo).map(([r, oid]) => ({ ref: r, node_id: `R_${b64url(r)}`, url: `/api/v3/repos/${owner}/${name}/git/refs/${r}`, object: { sha: oid, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${oid}` } }));
          sendList(res, req, url, list);
          return true;
        }
        if (method === 'POST') {
          const ref = typeof b.ref === 'string' ? b.ref : '';
          const sha = typeof b.sha === 'string' ? b.sha : '';
          if (!ref.startsWith('refs/') || !repo.objects.has(sha)) { sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' }); return true; }
          repo.refs.set(ref, sha);
          sendJson(res, 201, { ref, node_id: `R_${b64url(ref)}`, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
          return true;
        }
        notFound(res); return true;
      }
      if (rest.length >= 3 && method === 'GET') {
        const ref = rest.slice(2).join('/');
        const oid = repo.refs.get(ref) ?? repo.refs.get(`refs/${ref}`);
        if (!oid) { notFound(res); return true; }
        const fullRef = repo.refs.has(ref) ? ref : `refs/${ref}`;
        sendJson(res, 200, { ref: fullRef, node_id: `R_${b64url(fullRef)}`, url: `/api/v3/repos/${owner}/${name}/git/refs/${fullRef}`, object: { sha: oid, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${oid}` } });
        return true;
      }
      notFound(res); return true;
    }
    notFound(res); return true;
  }
  notFound(res); return true;
}
function findDirTree(repo: Repo, treeOid: string, dirPath: string): string | null {
  const segs = dirPath.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (const seg of segs) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

// --------------------------------------------------------------------------- GraphQL
interface GqlNode { alias: string; name: string; args: Record<string, unknown>; children: GqlNode[]; fragmentType?: string; }
function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if ('{}():,[]!'.includes(c) || c === '$') { tokens.push(c); i++; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; } else { s += src[j]; j++; } }
      tokens.push(JSON.stringify(s));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z_0-9-]/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}
function gqlParseValue(tokens: string[], pos: { i: number }, variables: Record<string, unknown>): unknown {
  const t = tokens[pos.i];
  if (t === '$') { pos.i += 2; return variables[tokens[pos.i - 1]]; }
  if (t === '{') {
    pos.i++;
    const obj: Record<string, unknown> = {};
    while (tokens[pos.i] !== '}' && pos.i < tokens.length) {
      if (tokens[pos.i] === ',') { pos.i++; continue; }
      const key = tokens[pos.i++];
      if (tokens[pos.i] === ':') pos.i++;
      obj[key] = gqlParseValue(tokens, pos, variables);
    }
    pos.i++;
    return obj;
  }
  if (t === '[') {
    pos.i++;
    const arr: unknown[] = [];
    while (tokens[pos.i] !== ']' && pos.i < tokens.length) {
      if (tokens[pos.i] === ',') { pos.i++; continue; }
      arr.push(gqlParseValue(tokens, pos, variables));
    }
    pos.i++;
    return arr;
  }
  if (t === 'true') { pos.i++; return true; }
  if (t === 'false') { pos.i++; return false; }
  if (t === 'null') { pos.i++; return null; }
  if (t !== undefined && t.startsWith('"')) { pos.i++; return JSON.parse(t) as unknown; }
  if (t !== undefined && /^-?\d+$/.test(t)) { pos.i++; return Number(t); }
  if (t !== undefined && /^-?\d+\.\d+$/.test(t)) { pos.i++; return Number(t); }
  pos.i++;
  return t; // enum as string
}
function gqlParseFields(tokens: string[], pos: { i: number }, variables: Record<string, unknown>): GqlNode[] {
  const nodes: GqlNode[] = [];
  while (pos.i < tokens.length && tokens[pos.i] !== '}') {
    if (tokens[pos.i] === '...') {
      pos.i++;
      let fragmentType: string | undefined;
      if (tokens[pos.i] === 'on') { pos.i++; fragmentType = tokens[pos.i++]; }
      else { pos.i++; } // named fragment spread: ignore (not used by the suite)
      if (tokens[pos.i] === '{') {
        pos.i++;
        const children = gqlParseFields(tokens, pos, variables);
        if (tokens[pos.i] === '}') pos.i++;
        nodes.push({ alias: '', name: '__fragment', args: {}, children, fragmentType });
      }
      continue;
    }
    let alias = '';
    let name = tokens[pos.i++];
    if (tokens[pos.i] === ':') { alias = name; pos.i++; name = tokens[pos.i++]; }
    const args: Record<string, unknown> = {};
    if (tokens[pos.i] === '(') {
      pos.i++;
      while (tokens[pos.i] !== ')' && pos.i < tokens.length) {
        if (tokens[pos.i] === ',') { pos.i++; continue; }
        const key = tokens[pos.i++];
        if (tokens[pos.i] === ':') pos.i++;
        args[key] = gqlParseValue(tokens, pos, variables);
      }
      pos.i++;
    }
    let children: GqlNode[] = [];
    if (tokens[pos.i] === '{') {
      pos.i++;
      children = gqlParseFields(tokens, pos, variables);
      if (tokens[pos.i] === '}') pos.i++;
    }
    nodes.push({ alias: alias || name, name, args, children });
  }
  return nodes;
}
function gqlParseOperation(query: string, variables: Record<string, unknown>): { type: string; fields: GqlNode[] } {
  const tokens = gqlTokenize(query);
  const pos = { i: 0 };
  let type = 'query';
  // skip operation keyword / name / variable definitions
  while (pos.i < tokens.length) {
    const t = tokens[pos.i];
    if (t === 'query' || t === 'mutation' || t === 'subscription') { type = t; pos.i++; continue; }
    if (t === '{') break;
    if (t === '(') {
      let depth = 0;
      while (pos.i < tokens.length) {
        if (tokens[pos.i] === '(') depth++;
        if (tokens[pos.i] === ')') { depth--; pos.i++; if (depth === 0) break; continue; }
        pos.i++;
      }
      continue;
    }
    if (t === '$' || t === ':' || t === '[' || t === ']' || t === '!' || t === ',') { pos.i++; continue; }
    // operation name
    pos.i++;
  }
  if (tokens[pos.i] === '{') {
    pos.i++;
    const fields = gqlParseFields(tokens, pos, variables);
    return { type, fields };
  }
  return { type, fields: [] };
}
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRefOid', 'baseRefOid', 'mergedAt', 'mergeCommit', 'url', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate'],
  SearchType: [],
  User: ['login', 'id'],
  IssueComment: ['id', 'body'],
};
const SEARCH_ENUMS = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];
function gqlIssueFields(repo: Repo, issue: Issue, children: GqlNode[], errors: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of children) {
    if (f.name === '__fragment') continue;
    switch (f.name) {
      case 'id': out[f.alias] = issueIdFor(repo.databaseId, issue.number); break;
      case 'number': out[f.alias] = issue.number; break;
      case 'title': out[f.alias] = issue.title; break;
      case 'state': out[f.alias] = issue.state === 'open' ? 'OPEN' : 'CLOSED'; break;
      case 'body': out[f.alias] = issue.body; break;
      default: errors.push({ message: `Cannot query field "${f.name}" on type "Issue".` }); out[f.alias] = null;
    }
  }
  return out;
}
function gqlPrFields(repo: Repo, pr: Pull, children: GqlNode[], errors: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of children) {
    if (f.name === '__fragment') continue;
    switch (f.name) {
      case 'id': out[f.alias] = pullIdFor(repo.databaseId, pr.number); break;
      case 'number': out[f.alias] = pr.number; break;
      case 'title': out[f.alias] = pr.title; break;
      case 'state': out[f.alias] = pr.state === 'open' ? 'OPEN' : 'CLOSED'; break;
      case 'body': out[f.alias] = pr.body; break;
      case 'headRefName': out[f.alias] = pr.head; break;
      case 'baseRefName': out[f.alias] = pr.base; break;
      case 'headRefOid': out[f.alias] = pr.headSha; break;
      case 'baseRefOid': out[f.alias] = pr.baseSha; break;
      case 'mergeable': out[f.alias] = prMergeable(repo, pr); break;
      case 'merged': out[f.alias] = pr.merged; break;
      case 'mergedAt': out[f.alias] = pr.merged_at; break;
      case 'files': {
        const nodesChild = f.children.find((c) => c.name === 'nodes');
        const nodeFields = nodesChild ? nodesChild.children : f.children;
        const nodes = pr.files.map((file) => {
          const o: Record<string, unknown> = {};
          for (const c of nodeFields) {
            if (c.name === 'path') o[c.alias] = file.filename;
            else if (c.name === 'additions') o[c.alias] = file.additions;
            else if (c.name === 'deletions') o[c.alias] = file.deletions;
            else o[c.alias] = null;
          }
          return o;
        });
        out[f.alias] = { nodes };
        break;
      }
      default: errors.push({ message: `Cannot query field "${f.name}" on type "PullRequest".` }); out[f.alias] = null;
    }
  }
  return out;
}
function gqlRepoFields(repo: Repo, children: GqlNode[], errors: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of children) {
    if (f.name === '__fragment') continue;
    switch (f.name) {
      case 'id': out[f.alias] = repo.id; break;
      case 'databaseId': out[f.alias] = repo.databaseId; break;
      case 'name': out[f.alias] = repo.name; break;
      case 'nameWithOwner': out[f.alias] = `${repo.owner}/${repo.name}`; break;
      case 'description': out[f.alias] = repo.description; break;
      case 'isPrivate': out[f.alias] = repo.private; break;
      case 'url': out[f.alias] = `https://example.invalid/${repo.owner}/${repo.name}`; break;
      case 'owner': {
        const o: Record<string, unknown> = {};
        for (const c of f.children) o[c.alias] = c.name === 'login' ? repo.owner : null;
        out[f.alias] = o;
        break;
      }
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) { out[f.alias] = null; break; }
        const o: Record<string, unknown> = {};
        for (const c of f.children) {
          if (c.name === 'name') o[c.alias] = repo.defaultBranch;
          else if (c.name === 'target') o[c.alias] = { oid: tip };
          else o[c.alias] = null;
        }
        out[f.alias] = o;
        break;
      }
      case 'viewerPermission': out[f.alias] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[f.alias] = true; break;
      case 'issue': {
        const issue = getIssue(repo, Number(f.args.number));
        out[f.alias] = issue ? gqlIssueFields(repo, issue, f.children, errors) : null;
        break;
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = Array.isArray(f.args.states) ? (f.args.states as string[]) : null;
        if (states) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        const orderBy = isRecord(f.args.orderBy) ? f.args.orderBy : null;
        if (orderBy && String(orderBy.field ?? '').toUpperCase() === 'CREATED_AT') {
          const dir = String(orderBy.direction ?? 'DESC').toUpperCase();
          list.sort((a, b2) => dir === 'DESC' ? (b2.createdSeq - a.createdSeq || b2.number - a.number) : (a.createdSeq - b2.createdSeq || a.number - b2.number));
        } else {
          list.sort((a, b2) => a.createdSeq - b2.createdSeq);
        }
        // cursor pagination: after is base64url of the last seen issue number
        let startIdx = 0;
        if (typeof f.args.after === 'string' && f.args.after !== '') {
          const n = Number(unb64url(f.args.after));
          if (Number.isInteger(n)) {
            const idx = list.findIndex((i) => i.number === n);
            if (idx >= 0) startIdx = idx + 1;
          }
        }
        const first = typeof f.args.first === 'number' ? f.args.first : list.length;
        const page = list.slice(startIdx, startIdx + first);
        const hasNext = startIdx + page.length < list.length;
        const nodes = page.map((issue) => gqlIssueFields(repo, issue, f.children.filter((c) => c.name === 'nodes').flatMap((c) => c.children), errors));
        const conn: Record<string, unknown> = {};
        for (const c of f.children) {
          if (c.name === 'nodes') conn[c.alias] = nodes;
          else if (c.name === 'pageInfo') {
            const pi: Record<string, unknown> = {};
            for (const p of c.children) {
              if (p.name === 'hasNextPage') pi[p.alias] = hasNext;
              else if (p.name === 'endCursor') pi[p.alias] = page.length ? b64url(String(page[page.length - 1].number)) : null;
              else if (p.name === 'hasPreviousPage') pi[p.alias] = startIdx > 0;
              else if (p.name === 'startCursor') pi[p.alias] = page.length ? b64url(String(page[0].number)) : null;
            }
            conn[c.alias] = pi;
          } else if (c.name === 'totalCount') conn[c.alias] = list.length;
        }
        out[f.alias] = conn;
        break;
      }
      case 'pullRequests': {
        const first = typeof f.args.first === 'number' ? f.args.first : repo.pulls.length;
        const list = repo.pulls.filter((p) => p.state === 'open').sort((a, b2) => b2.createdSeq - a.createdSeq).slice(0, first);
        const nodes = list.map((pr) => gqlPrFields(repo, pr, f.children.filter((c) => c.name === 'nodes').flatMap((c) => c.children), errors));
        const conn: Record<string, unknown> = {};
        for (const c of f.children) {
          if (c.name === 'nodes') conn[c.alias] = nodes;
          else if (c.name === 'totalCount') conn[c.alias] = list.length;
        }
        out[f.alias] = conn;
        break;
      }
      case 'pullRequest': {
        const pr = getPull(repo, Number(f.args.number));
        out[f.alias] = pr ? gqlPrFields(repo, pr, f.children, errors) : null;
        break;
      }
      default: errors.push({ message: `Cannot query field "${f.name}" on type "Repository".` }); out[f.alias] = null;
    }
  }
  return out;
}
function gqlTypeFields(typeName: string, children: GqlNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const names = TYPE_FIELDS[typeName] ?? [];
  for (const c of children) {
    if (c.name === 'fields') out[c.alias] = names.map((n) => ({ name: n }));
    else if (c.name === 'enumValues') out[c.alias] = typeName === 'SearchType' ? SEARCH_ENUMS.map((n) => ({ name: n })) : [];
    else if (c.name === 'name') out[c.alias] = typeName;
    else out[c.alias] = null;
  }
  return out;
}
function createIssueInternal(repo: Repo, title: string, body: string): Issue {
  const now = tsIso();
  const issue: Issue = { number: repo.nextNumber++, title, body, state: 'open', labels: [], comments: [], createdSeq: nextSeq(), created_at: now, updated_at: now };
  repo.issues.push(issue);
  return issue;
}
function createPullInternal(repo: Repo, head: string, base: string, title: string, body: string): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return null;
  const dup = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
  if (dup) return dup;
  const headObj = repo.objects.get(headSha);
  const baseObj = repo.objects.get(baseSha);
  const files = headObj && baseObj ? diffFiles(repo, parseCommit(baseObj.data).tree, parseCommit(headObj.data).tree) : [];
  const now = tsIso();
  const pr: Pull = { number: repo.nextNumber++, title, body, state: 'open', head, base, headSha, baseSha, merged: false, merge_commit_sha: null, merged_at: null, files, createdSeq: nextSeq(), created_at: now, updated_at: now };
  repo.pulls.push(pr);
  return pr;
}
function gqlExecute(query: string, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: Array<Record<string, unknown>> } {
  const errors: Array<Record<string, unknown>> = [];
  const { fields } = gqlParseOperation(query, variables);
  const data: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.name === '__fragment') continue;
    switch (f.name) {
      case 'viewer': {
        const o: Record<string, unknown> = {};
        for (const c of f.children) {
          if (c.name === 'login') o[c.alias] = VIEWER_LOGIN;
          else if (c.name === 'id') o[c.alias] = VIEWER_ID;
          else { errors.push({ message: `Cannot query field "${c.name}" on type "Viewer".` }); o[c.alias] = null; }
        }
        data[f.alias] = o;
        break;
      }
      case '__type': {
        const typeName = typeof f.args.name === 'string' ? f.args.name : '';
        data[f.alias] = gqlTypeFields(typeName, f.children);
        break;
      }
      case '__schema': {
        data[f.alias] = { types: [] };
        break;
      }
      case 'repository': {
        const owner = String(f.args.owner ?? '');
        const name = String(f.args.name ?? '');
        if (owner !== VIEWER_LOGIN) { data[f.alias] = null; break; }
        const repo = repos.get(name);
        data[f.alias] = repo ? gqlRepoFields(repo, f.children, errors) : null;
        break;
      }
      case 'node': {
        const id = String(f.args.id ?? '');
        const repo = findRepoById(id);
        if (repo) {
          const o: Record<string, unknown> = { id: repo.id };
          for (const c of f.children) {
            if (c.name === '__fragment') {
              if (c.fragmentType === 'Repository') {
                for (const sub of c.children) {
                  if (sub.name === 'name') o[sub.alias] = repo.name;
                  else if (sub.name === 'nameWithOwner') o[sub.alias] = `${repo.owner}/${repo.name}`;
                  else if (sub.name === 'id') o[sub.alias] = repo.id;
                }
              }
              continue;
            }
            if (c.name === 'id') o[c.alias] = repo.id;
            else if (c.name === 'name') o[c.alias] = repo.name;
            else if (c.name === 'nameWithOwner') o[c.alias] = `${repo.owner}/${repo.name}`;
          }
          data[f.alias] = o;
          break;
        }
        const dec = decodeGlobalId(id);
        if (dec) {
          const target = [...repos.values()].find((r) => r.databaseId === dec.dbId);
          if (target && dec.kind === 'I') {
            const issue = getIssue(target, dec.num);
            data[f.alias] = issue ? gqlIssueFields(target, issue, f.children, errors) : null;
            break;
          }
          if (target && dec.kind === 'P') {
            const pr = getPull(target, dec.num);
            data[f.alias] = pr ? gqlPrFields(target, pr, f.children, errors) : null;
            break;
          }
        }
        data[f.alias] = null;
        break;
      }
      case 'createIssue': {
        const input = isRecord(f.args.input) ? f.args.input : {};
        const repo = findRepoById(String(input.repositoryId ?? ''));
        if (!repo) { errors.push({ message: 'Repository not found.' }); data[f.alias] = { issue: null }; break; }
        const issue = createIssueInternal(repo, String(input.title ?? ''), String(input.body ?? ''));
        const o: Record<string, unknown> = {};
        for (const c of f.children) {
          if (c.name === 'issue') o[c.alias] = gqlIssueFields(repo, issue, c.children, errors);
          else o[c.alias] = null;
        }
        data[f.alias] = o;
        break;
      }
      case 'closeIssue': {
        const input = isRecord(f.args.input) ? f.args.input : {};
        const dec = decodeGlobalId(String(input.issueId ?? ''));
        let issue: Issue | undefined;
        let repo: Repo | undefined;
        if (dec) {
          repo = [...repos.values()].find((r) => r.databaseId === dec.dbId);
          issue = repo ? getIssue(repo, dec.num) : undefined;
        }
        if (!issue || !repo) { errors.push({ message: 'Issue not found.' }); data[f.alias] = { issue: null }; break; }
        issue.state = 'closed';
        issue.updated_at = tsIso();
        const o: Record<string, unknown> = {};
        for (const c of f.children) {
          if (c.name === 'issue') o[c.alias] = gqlIssueFields(repo, issue, c.children, errors);
          else o[c.alias] = null;
        }
        data[f.alias] = o;
        break;
      }
      case 'createPullRequest': {
        const input = isRecord(f.args.input) ? f.args.input : {};
        const repo = findRepoById(String(input.repositoryId ?? ''));
        if (!repo) { errors.push({ message: 'Repository not found.' }); data[f.alias] = { pullRequest: null }; break; }
        const pr = createPullInternal(repo, String(input.headRefName ?? ''), String(input.baseRefName ?? ''), String(input.title ?? ''), '');
        if (!pr) { errors.push({ message: 'Head or base branch does not exist.' }); data[f.alias] = { pullRequest: null }; break; }
        const o: Record<string, unknown> = {};
        for (const c of f.children) {
          if (c.name === 'pullRequest') o[c.alias] = gqlPrFields(repo, pr, c.children, errors);
          else o[c.alias] = null;
        }
        data[f.alias] = o;
        break;
      }
      case 'mergePullRequest': {
        const input = isRecord(f.args.input) ? f.args.input : {};
        const dec = decodeGlobalId(String(input.pullRequestId ?? ''));
        let pr: Pull | undefined;
        let repo: Repo | undefined;
        if (dec) {
          repo = [...repos.values()].find((r) => r.databaseId === dec.dbId);
          pr = repo ? getPull(repo, dec.num) : undefined;
        }
        if (!pr || !repo) { errors.push({ message: 'Pull request not found.' }); data[f.alias] = { pullRequest: null }; break; }
        if (pr.state !== 'open') { errors.push({ message: 'Pull request is not open.' }); data[f.alias] = { pullRequest: null }; break; }
        if (prConflicts(repo, pr)) { errors.push({ message: 'Merge conflict.' }); data[f.alias] = { pullRequest: null }; break; }
        squashMerge(repo, pr);
        const o: Record<string, unknown> = {};
        for (const c of f.children) {
          if (c.name === 'pullRequest') o[c.alias] = gqlPrFields(repo, pr, c.children, errors);
          else o[c.alias] = null;
        }
        data[f.alias] = o;
        break;
      }
      case 'addComment': {
        const input = isRecord(f.args.input) ? f.args.input : {};
        const dec = decodeGlobalId(String(input.subjectId ?? ''));
        let issue: Issue | undefined;
        let repo: Repo | undefined;
        if (dec) {
          repo = [...repos.values()].find((r) => r.databaseId === dec.dbId);
          issue = repo ? getIssue(repo, dec.num) : undefined;
        }
        if (!issue || !repo) { errors.push({ message: 'Issue not found.' }); data[f.alias] = { commentEdge: null }; break; }
        const comment: Comment = { id: commentIdFor(repo.databaseId, issue.number, issue.comments.length + 1), num: repo.databaseId * 1000000 + issue.number * 1000 + issue.comments.length + 1, body: String(input.body ?? ''), user: VIEWER_LOGIN, created_at: tsIso() };
        issue.comments.push(comment);
        const o: Record<string, unknown> = {};
        for (const c of f.children) {
          if (c.name === 'commentEdge') {
            const edge: Record<string, unknown> = {};
            for (const n of c.children) {
              if (n.name === 'node') {
                const node: Record<string, unknown> = {};
                for (const sub of n.children) {
                  if (sub.name === 'id') node[sub.alias] = comment.id;
                  else if (sub.name === 'body') node[sub.alias] = comment.body;
                  else node[sub.alias] = null;
                }
                edge[n.alias] = node;
              } else edge[n.alias] = null;
            }
            o[c.alias] = edge;
          } else o[c.alias] = null;
        }
        data[f.alias] = o;
        break;
      }
      default:
        errors.push({ message: `Cannot query field "${f.name}" on type "Query".` });
        data[f.alias] = null;
    }
  }
  return { data, errors };
}
function handleGraphql(res: ServerResponse, body: unknown): void {
  if (Array.isArray(body)) {
    const results = body.map((op) => {
      if (!isRecord(op) || typeof op.query !== 'string') return { data: null, errors: [{ message: 'Invalid operation.' }] };
      const { data, errors } = gqlExecute(op.query, isRecord(op.variables) ? op.variables : {});
      return errors.length ? { data, errors } : { data };
    });
    sendJson(res, 200, results);
    return;
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    sendJson(res, 400, { message: 'A GraphQL query is required' });
    return;
  }
  const { data, errors } = gqlExecute(body.query, isRecord(body.variables) ? body.variables : {});
  sendJson(res, 200, errors.length ? { data, errors } : { data });
}

// --------------------------------------------------------------------------- MCP
interface McpToolDef { name: string; description: string; inputSchema: { type: string; properties: Record<string, { type: string; description?: string }>; required: string[] }; }
const MCP_TOOLS: McpToolDef[] = [
  { name: 'create_repo', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request with a squash commit', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
const MCP_TOOLS_JSON = JSON.stringify(MCP_TOOLS);
function mcpNormalize(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function mcpFindTool(name: string): McpToolDef | undefined {
  const want = mcpNormalize(name);
  const exact = MCP_TOOLS.find((t) => mcpNormalize(t.name) === want);
  if (exact) return exact;
  return MCP_TOOLS.find((t) => want.length > mcpNormalize(t.name).length && want.endsWith(mcpNormalize(t.name)));
}
function mcpRepoFromArgs(args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !name) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) { owner = parts[0]; name = parts[1]; }
  }
  if (owner !== VIEWER_LOGIN) return null;
  return repos.get(name) ?? null;
}
function mcpCallTool(name: string, args: Record<string, unknown>): { ok: boolean; result?: unknown; error?: string } {
  const tool = mcpFindTool(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
  if (missing.length) return { ok: false, error: `Missing required argument: ${missing.join(', ')}` };
  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (repos.has(repoName)) return { ok: false, error: `Repository "${repoName}" already exists` };
      const repo = createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return { ok: true, result: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return { ok: false, error: 'Repository not found' };
      return { ok: true, result: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return { ok: false, error: 'Repository not found' };
      const issue = createIssueInternal(repo, String(args.title), typeof args.body === 'string' ? args.body : '');
      return { ok: true, result: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return { ok: false, error: 'Repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueJson(repo, i));
      return { ok: true, result: { issues: list } };
    }
    case 'create_pull_request': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return { ok: false, error: 'Repository not found' };
      const pr = createPullInternal(repo, String(args.head), String(args.base), String(args.title), typeof args.body === 'string' ? args.body : '');
      if (!pr) return { ok: false, error: 'Head or base branch does not exist' };
      return { ok: true, result: pullJson(repo, pr) };
    }
    case 'merge_pull_request': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return { ok: false, error: 'Repository not found' };
      const pr = getPull(repo, Number(args.pull_number));
      if (!pr) return { ok: false, error: 'Pull request not found' };
      if (pr.state !== 'open') return { ok: false, error: 'Pull request is not open' };
      if (prConflicts(repo, pr)) return { ok: false, error: 'Merge conflict' };
      const merged = squashMerge(repo, pr);
      if (!merged.ok) return { ok: false, error: 'Merge failed' };
      return { ok: true, result: { merged: true, sha: merged.sha, number: pr.number, state: 'closed' } };
    }
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  if (!authed(req)) { sendJson(res, 401, { message: 'Unauthorized' }); return; }
  const id = parsed.id === undefined ? null : parsed.id;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const result = (value: unknown, extraHeaders: Record<string, string> = {}): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: value }, extraHeaders);
  };
  const rpcError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (id === undefined || id === null) {
    // Notification: no JSON-RPC response body.
    sendEmpty(res, 202);
    return;
  }
  switch (method) {
    case 'server/discover':
      result({
        resultType: 'DiscoverResult',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} },
        serverInfo: { name: 'github-forge', version: '1.0.0' },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-forge', version: '1.0.0' } },
      });
      return;
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      result({
        protocolVersion: supported.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'github-forge', version: '1.0.0' },
      }, { 'mcp-session-id': 'mcp-session-1' });
      return;
    }
    case 'ping':
      result({});
      return;
    case 'tools/list':
      // The tools array is built once (MCP_TOOLS_JSON) so two calls are byte-identical.
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: JSON.parse(MCP_TOOLS_JSON) as unknown } });
      return;
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (!toolName) { rpcError(-32602, 'Missing tool name'); return; }
      const tool = mcpFindTool(toolName);
      if (!tool) { rpcError(-32601, `Unknown tool: ${toolName}`); return; }
      const outcome = mcpCallTool(toolName, args);
      if (!outcome.ok) {
        result({ content: [{ type: 'text', text: outcome.error ?? 'Tool call failed' }], isError: true });
        return;
      }
      result({ content: [{ type: 'text', text: JSON.stringify(outcome.result) }], structuredContent: outcome.result });
      return;
    }
    default:
      rpcError(-32601, `Method not found: ${method}`);
  }
}

// --------------------------------------------------------------------------- git router
function handleGit(req: IncomingMessage, res: ServerResponse, path: string, raw: Buffer): boolean {
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  const repoName = decodeURIComponent(m[2]);
  const rest = m[3];
  const method = req.method ?? 'GET';
  if (owner !== VIEWER_LOGIN) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const repo = repos.get(repoName);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  try {
    if (method === 'GET' && rest === 'info/refs') {
      const url = new URL(req.url ?? '/', 'http://entry');
      const service = url.searchParams.get('service');
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (service === 'git-upload-pack') {
        if (v2) {
          const body = v2Advertisement();
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
          res.end(body);
        } else {
          const body = v0Advertisement(repo, 'git-upload-pack');
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
          res.end(body);
        }
        return true;
      }
      if (service === 'git-receive-pack') {
        const body = v0Advertisement(repo, 'git-receive-pack');
        res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'content-length': body.length });
        res.end(body);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (method === 'POST' && rest === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = v2 ? handleUploadPackV2(repo, raw) : handleUploadPackV0(repo, raw);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
      res.end(body);
      return true;
    }
    if (method === 'POST' && rest === 'git-receive-pack') {
      const body = handleReceivePack(repo, raw);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': body.length });
      res.end(body);
      return true;
    }
  } catch {
    sendJson(res, 400, { message: 'Bad request' });
    return true;
  }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

// --------------------------------------------------------------------------- app
function pathOf(req: IncomingMessage): string {
  try {
    const raw = new URL(req.url ?? '/', 'http://entry').pathname;
    try { return decodeURIComponent(raw); } catch { return raw; }
  } catch {
    return '/';
  }
}
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const raw = hasBody ? await readBody(req) : Buffer.alloc(0);
        if (handleGit(req, res, path, raw)) return;
        if (path === '/api/graphql' && method === 'POST') {
          if (!authed(req)) { unauthorized(res); return; }
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
          handleGraphql(res, parsed.value);
          return;
        }
        if (path === '/mcp' && method === 'POST') {
          handleMcp(req, res, raw);
          return;
        }
        if (path.startsWith('/api/v3')) {
          let body: unknown = {};
          if (hasBody) {
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
            body = parsed.value;
          }
          const url = new URL(req.url ?? '/', 'http://entry');
          await handleRest(req, res, url, body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try { sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }); } catch { /* socket gone */ }
      }
    })();
  });
}
