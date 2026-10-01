import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSeed, validateDocument } from './document.js';

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
});
