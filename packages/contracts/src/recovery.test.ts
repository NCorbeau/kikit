import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { encodeUpdate } from './index.js';
import { MAX_DOCUMENT_BYTES } from './document-schema.js';
import { MAX_UPDATE_BYTES } from './protocol-schema.js';
import { MAX_RECOVERY_FILE_BYTES, MAX_RECOVERY_PENDING_BATCHES, parseRecoveryFile, validateRecoveryState } from './recovery.js';

const accountId = 'account-a';
const pageId = '00000000-0000-4000-8000-000000000001';
const context = { accountId, pageId };

function paragraph(text: string, id?: string): Y.XmlElement {
  const block = new Y.XmlElement('paragraph');
  if (id) block.setAttribute('id', id);
  const value = new Y.XmlText();
  value.insert(0, text);
  block.insert(0, [value]);
  return block;
}

function fixture() {
  const doc = new Y.Doc({ gc: false });
  doc.getXmlFragment('title').insert(0, [paragraph('Recovered title')]);
  const block = paragraph('Original writing', 'stable-block');
  doc.getXmlFragment('body').insert(0, [block]);
  const pending: Array<{ batchId: string; update: string }> = [];
  doc.on('update', (update: Uint8Array) => pending.push({ batchId: randomUUID(), update: encodeUpdate(update) }));
  const text = block.get(0) as Y.XmlText;
  text.insert(text.length, ' offline draft');
  text.delete(0, 3);
  const file = {
    format: 'kikit-recovery', formatVersion: 2, schemaVersion: 2, protocolVersion: 2,
    accountId, pageId, exportedAt: '2026-10-07T12:00:00.000Z',
    update: encodeUpdate(Y.encodeStateAsUpdate(doc)), cachedUpdates: [], pending,
  };
  return { doc, text, file };
}

function serialize(value: unknown): string { return JSON.stringify(value); }

describe('binary recovery files', () => {
  it('preserves binary identity, deleted history and exact pending identities/bytes', () => {
    const { doc, file } = fixture();
    const source = serialize(file);
    const parsed = parseRecoveryFile(source, context);
    const restored = new Y.Doc({ gc: false });
    Y.applyUpdate(restored, parsed.update);
    expect(parsed.title).toBe('Recovered title');
    expect(parsed.update).toEqual(Y.encodeStateAsUpdate(doc));
    expect(Y.encodeStateAsUpdate(restored)).toEqual(Y.encodeStateAsUpdate(doc));
    expect([...Y.decodeUpdate(parsed.update).ds.clients.values()].flat().length).toBeGreaterThan(0);
    expect(parsed.pending.map(record => ({ batchId: record.batchId, update: encodeUpdate(record.update) }))).toEqual(file.pending);
    expect(source).toBe(serialize(file));
    restored.destroy(); doc.destroy();
  });

  it.each([1, 2])('accepts the existing format 1 export with document schema %s without rewriting it', schemaVersion => {
    const { doc, file } = fixture();
    const { protocolVersion: _unused, ...legacy } = file;
    const parsed = parseRecoveryFile(serialize({ ...legacy, formatVersion: 1, schemaVersion }), context);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.sourceSchemaVersion).toBe(schemaVersion);
    expect(parsed.protocolVersion).toBe(2);
    expect(encodeUpdate(parsed.update)).toBe(file.update);
    doc.destroy();
  });

  it('keeps repairable empty containers binary intact for server normalization', () => {
    const { doc, file } = fixture();
    doc.getXmlFragment('body').delete(0, 1);
    file.update = encodeUpdate(Y.encodeStateAsUpdate(doc));
    expect(validateRecoveryState(parseRecoveryFile(serialize(file), context).update)).toBe('Recovered title');
    expect(doc.getXmlFragment('body').length).toBe(0);
    doc.destroy();
  });

  it.each([
    { formatVersion: 3 }, { schemaVersion: 99 }, { protocolVersion: 99 },
    { exportedAt: 'yesterday' }, { pageId: 'unknown-note' }, { secret: 'unexpected metadata' },
  ])('rejects incompatible or malformed metadata %j', patch => {
    const { doc, file } = fixture();
    expect(() => parseRecoveryFile(serialize({ ...file, ...patch }), context)).toThrow('unsupported version, invalid metadata');
    doc.destroy();
  });

  it('requires the exporting account and original-note identity without revealing content', () => {
    const { doc, file } = fixture();
    expect(() => parseRecoveryFile(serialize(file), { accountId: 'other' })).toThrow('account that exported');
    expect(() => parseRecoveryFile(serialize(file), { ...context, pageId: randomUUID() })).toThrow('different note');
    expect(parseRecoveryFile(serialize(file), { accountId }).pageId).toBe(pageId);
    doc.destroy();
  });

  it('rejects incompatible cached updates instead of partially importing a file', () => {
    const { doc, file } = fixture();
    expect(() => parseRecoveryFile(serialize({ ...file, cachedUpdates: [{ update: file.update }] }), context)).toThrow('incompatible local cache');
    doc.destroy();
  });

  it('rejects duplicate pending identities', () => {
    const { doc, file } = fixture();
    expect(() => parseRecoveryFile(serialize({ ...file, pending: [file.pending[0], file.pending[0]] }), context)).toThrow('repeats a pending batch');
    const batchId = 'abcdef00-0000-4000-8000-000000000001';
    expect(() => parseRecoveryFile(serialize({ ...file, pending: [
      { ...file.pending[0], batchId }, { ...file.pending[0], batchId: batchId.toUpperCase() },
    ] }), context)).toThrow('repeats a pending batch');
    doc.destroy();
  });

  it('rejects a pending insertion omitted from the full recovery state', () => {
    const { doc, text, file } = fixture();
    text.insert(text.length, ' not in exported full state');
    expect(() => parseRecoveryFile(serialize(file), context)).toThrow('pending batches are damaged, incomplete');
    doc.destroy();
  });

  it('rejects a pending deletion omitted from the full state even when the state vector matches', () => {
    const { doc, text, file } = fixture();
    text.delete(0, 1);
    expect(() => parseRecoveryFile(serialize(file), context)).toThrow('pending batches are damaged, incomplete');
    doc.destroy();
  });

  it('rejects forged text using a client/clock already covered by the full update', () => {
    const full = new Y.Doc({ gc: false });
    const forged = new Y.Doc({ gc: false });
    full.clientID = forged.clientID = 42;
    for (const [doc, value] of [[full, 'real text'], [forged, 'fake text']] as const) {
      doc.getXmlFragment('title').insert(0, [paragraph('Recovered title')]);
      doc.getXmlFragment('body').insert(0, [paragraph(value, 'stable-block')]);
    }
    const { doc, file } = fixture();
    file.update = encodeUpdate(Y.encodeStateAsUpdate(full));
    file.pending = [{ batchId: randomUUID(), update: encodeUpdate(Y.encodeStateAsUpdate(forged)) }];
    expect(() => parseRecoveryFile(serialize(file), context)).toThrow('pending batches are damaged');
    full.destroy(); forged.destroy(); doc.destroy();
  });

  it('allows non-GC pending history when the exported full document already garbage-collected deleted content', () => {
    const source = new Y.Doc();
    source.getXmlFragment('title').insert(0, [paragraph('Recovered title')]);
    const block = paragraph('delete this text', 'stable-block');
    source.getXmlFragment('body').insert(0, [block]);
    const original = Y.encodeStateAsUpdate(source);
    (block.get(0) as Y.XmlText).delete(0, 6);
    const { doc, file } = fixture();
    file.update = encodeUpdate(Y.encodeStateAsUpdate(source));
    file.pending = [{ batchId: randomUUID(), update: encodeUpdate(original) }];
    expect(parseRecoveryFile(serialize(file), context).update).toEqual(Y.encodeStateAsUpdate(source));
    source.destroy(); doc.destroy();
  });

  it('rejects unresolved causality in the full state', () => {
    const { doc, text, file } = fixture();
    const state = Y.encodeStateVector(doc);
    text.insert(text.length, ' missing its prior structs');
    file.update = encodeUpdate(Y.encodeStateAsUpdate(doc, state));
    expect(() => parseRecoveryFile(serialize(file), context)).toThrow('damaged, incomplete');
    doc.destroy();
  });

  it.each(['%%%=', 'AAAA', 'AB=='])('rejects invalid binary or noncanonical base64 %s', update => {
    const { doc, file } = fixture();
    expect(() => parseRecoveryFile(serialize({ ...file, update }), context)).toThrow();
    doc.destroy();
  });

  it('rejects trailing junk in full and pending binary payloads', () => {
    const { doc, file } = fixture();
    const trailing = encodeUpdate(Uint8Array.from([...Y.encodeStateAsUpdate(doc), 0]));
    expect(() => parseRecoveryFile(serialize({ ...file, update: trailing }), context)).toThrow('damaged, incomplete');
    expect(() => parseRecoveryFile(serialize({ ...file, pending: [{ batchId: randomUUID(), update: trailing }] }), context)).toThrow('pending batches are damaged');
    doc.destroy();
  });

  it.each(['fragment', 'mark', 'node'])('refuses unknown document %s content', kind => {
    const { doc, text, file } = fixture();
    if (kind === 'fragment') doc.getMap('permissions').set('owner', accountId);
    if (kind === 'mark') text.format(0, 1, { bold: true });
    if (kind === 'node') doc.getXmlFragment('body').insert(1, [new Y.XmlElement('image')]);
    file.update = encodeUpdate(Y.encodeStateAsUpdate(doc));
    expect(() => parseRecoveryFile(serialize(file), context)).toThrow('unsupported content');
    doc.destroy();
  });

  it('does not promote a schema 1 file containing schema 2 task lists', () => {
    const { doc, file } = fixture();
    const list = new Y.XmlElement('taskList');
    list.setAttribute('id', 'list');
    doc.getXmlFragment('body').insert(1, [list]);
    file.update = encodeUpdate(Y.encodeStateAsUpdate(doc));
    const { protocolVersion: _unused, ...legacy } = file;
    expect(() => parseRecoveryFile(serialize({ ...legacy, formatVersion: 1, schemaVersion: 1 }), context)).toThrow('outside its document version');
    doc.destroy();
  });

  it('bounds full-state bytes, pending bytes, pending count and total file bytes', () => {
    const { doc, file } = fixture();
    expect(() => parseRecoveryFile(serialize({ ...file, update: encodeUpdate(new Uint8Array(MAX_DOCUMENT_BYTES + 1)) }), context)).toThrow();
    expect(() => validateRecoveryState(new Uint8Array(MAX_DOCUMENT_BYTES + 1))).toThrow();
    expect(() => parseRecoveryFile(serialize({ ...file, pending: [{ batchId: randomUUID(), update: encodeUpdate(new Uint8Array(MAX_UPDATE_BYTES + 1)) }] }), context)).toThrow();
    expect(() => parseRecoveryFile(serialize({ ...file, pending: Array.from({ length: MAX_RECOVERY_PENDING_BATCHES + 1 }, () => ({ batchId: randomUUID(), update: 'AAA=' })) }), context)).toThrow();
    expect(() => parseRecoveryFile(' '.repeat(MAX_RECOVERY_FILE_BYTES + 1), context)).toThrow('16 MiB');
    expect(() => parseRecoveryFile('é'.repeat(MAX_RECOVERY_FILE_BYTES / 2 + 1), context)).toThrow('16 MiB');
    doc.destroy();
  });

  it('rejects invalid JSON with a functional message', () => {
    expect(() => parseRecoveryFile('{', context)).toThrow('valid Kikit recovery JSON');
  });
});
