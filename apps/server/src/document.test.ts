import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSeed, normalizeEmptyBody, validateDocument } from './document.js';

describe('document schema', () => {
  it('initializes editor-compatible title and stable body blocks only on the server', () => {
    const doc = new Y.Doc(); Y.applyUpdate(doc, createSeed());
    expect(() => validateDocument(doc)).not.toThrow();
    expect(doc.getXmlFragment('title').length).toBe(1);
    expect((doc.getXmlFragment('body').get(0) as Y.XmlElement).getAttribute('id')).toBeTruthy();
    doc.destroy();
  });
  it('rejects unsupported marks and heading levels without mutating committed state', () => {
    const doc = new Y.Doc(); Y.applyUpdate(doc, createSeed());
    const body = doc.getXmlFragment('body'); const block = body.get(0) as Y.XmlElement;
    const text = block.get(0) as Y.XmlText;
    text.format(0, 1, { bold: true });
    expect(() => validateDocument(doc)).toThrow('Only plain text');
    text.format(0, 1, { bold: null });
    const heading = new Y.XmlElement('heading'); heading.setAttribute('id', 'heading'); heading.setAttribute('level', '4'); body.insert(1, [heading]);
    expect(() => validateDocument(doc)).toThrow('Unsupported heading level');
    doc.destroy();
  });
  it('repairs concurrent block deletions with a stable empty paragraph without reseeding title or history', () => {
    const base = new Y.Doc(); Y.applyUpdate(base, createSeed());
    const second = new Y.XmlElement('paragraph'); second.setAttribute('id', 'second');
    base.getXmlFragment('body').insert(1, [second]);
    const a = new Y.Doc(); const b = new Y.Doc();
    const seed = Y.encodeStateAsUpdate(base);
    Y.applyUpdate(a, seed); Y.applyUpdate(b, seed);
    a.getXmlFragment('body').delete(0, 1);
    b.getXmlFragment('body').delete(1, 1);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(() => validateDocument(a)).toThrow('body blocks');
    const title = a.getXmlFragment('title').toString();
    normalizeEmptyBody(a);
    expect(() => validateDocument(a)).not.toThrow();
    const id = (a.getXmlFragment('body').get(0) as Y.XmlElement).getAttribute('id');
    expect(id).toBeTruthy();
    normalizeEmptyBody(a);
    expect(a.getXmlFragment('body').length).toBe(1);
    expect((a.getXmlFragment('body').get(0) as Y.XmlElement).getAttribute('id')).toBe(id);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(b.getXmlFragment('body').toString()).toBe(a.getXmlFragment('body').toString());
    expect(a.getXmlFragment('title').toString()).toBe(title);
    base.destroy(); a.destroy(); b.destroy();
  });
});
