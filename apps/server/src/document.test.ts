import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSeed, normalizeEmptyBody, validateDocument } from './document.js';

describe('document schema', () => {

  function task(checked: unknown = false): Y.XmlElement {
    const item = new Y.XmlElement('taskItem');
    item.setAttribute('id', 'item');
    item.setAttribute('checked', checked as string);
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.setAttribute('id', 'task-paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'A task');
    paragraph.insert(0, [text]);
    item.insert(0, [paragraph]);
    return item;
  }

  function withTasks(checked: unknown = false): { doc: Y.Doc; list: Y.XmlElement; item: Y.XmlElement } {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createSeed());
    const list = new Y.XmlElement('taskList');
    list.setAttribute('id', 'list');
    const item = task(checked);
    list.insert(0, [item]);
    doc.getXmlFragment('body').insert(1, [list]);
    return { doc, list, item };
  }

  it.each([true, false])('accepts flat task lists with an actual boolean checked state (%s)', checked => {
    const { doc } = withTasks(checked);
    expect(() => validateDocument(doc)).not.toThrow();
    expect(normalizeEmptyBody(doc)).toBe(false);
    doc.destroy();
  });

  it.each(['true', 'false', 0, 1, null, undefined])('rejects non-boolean task checked state (%s)', checked => {
    const { doc, item } = withTasks();
    if (checked === undefined) item.removeAttribute('checked');
    else item.setAttribute('checked', checked as string);
    expect(() => validateDocument(doc)).toThrow('boolean checked');
    expect(() => normalizeEmptyBody(doc)).toThrow('boolean checked');
    doc.destroy();
  });

  it.each(['nesting', 'heading', 'multiple paragraphs', 'title list', 'item attribute', 'list attribute', 'marks', 'missing paragraph id'])('rejects unsupported task structure: %s', variation => {
    const { doc, list, item } = withTasks();
    const paragraph = item.get(0) as Y.XmlElement;
    switch (variation) {
      case 'nesting': item.insert(1, [new Y.XmlElement('taskList')]); break;
      case 'heading': item.delete(0, 1); item.insert(0, [new Y.XmlElement('heading')]); break;
      case 'multiple paragraphs': item.insert(1, [new Y.XmlElement('paragraph')]); break;
      case 'title list': doc.getXmlFragment('title').delete(0, 1); doc.getXmlFragment('title').insert(0, [new Y.XmlElement('taskList')]); break;
      case 'item attribute': item.setAttribute('role', 'owner'); break;
      case 'list attribute': list.setAttribute('start', '1'); break;
      case 'marks': (paragraph.get(0) as Y.XmlText).format(0, 1, { bold: true }); break;
      case 'missing paragraph id': paragraph.removeAttribute('id'); break;
    }
    expect(() => validateDocument(doc)).toThrow();
    expect(() => normalizeEmptyBody(doc)).toThrow();
    doc.destroy();
  });

  it('normalizes a list emptied by independent item deletions and propagates the same stable repair', () => {
    const { doc: base, list } = withTasks();
    const second = task(true);
    second.setAttribute('id', 'second-task');
    list.insert(1, [second]);
    (second.get(0) as Y.XmlElement).setAttribute('id', 'second-paragraph');
    const a = new Y.Doc(), b = new Y.Doc();
    for (const doc of [a, b]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
    (a.getXmlFragment('body').get(1) as Y.XmlElement).delete(0, 1);
    (b.getXmlFragment('body').get(1) as Y.XmlElement).delete(1, 1);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(() => validateDocument(a)).toThrow('require items');
    expect(normalizeEmptyBody(a)).toBe(true);
    const repaired = a.getXmlFragment('body').get(1) as Y.XmlElement;
    expect(repaired.getAttribute('id')).toBe('list');
    expect((repaired.get(0) as Y.XmlElement).getAttribute('checked')).toBe(false);
    expect(normalizeEmptyBody(a)).toBe(false);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(b.getXmlFragment('body').toString()).toBe(a.getXmlFragment('body').toString());
    base.destroy(); a.destroy(); b.destroy();
  });

  it('repairs an otherwise valid empty task item without changing its checked state or identity', () => {
    const { doc, item } = withTasks(true);
    item.delete(0, 1);
    expect(normalizeEmptyBody(doc)).toBe(true);
    expect(item.getAttribute('checked')).toBe(true);
    expect(item.getAttribute('id')).toBe('item');
    expect((item.get(0) as Y.XmlElement).getAttribute('id')).toBeTruthy();
    expect(() => validateDocument(doc)).not.toThrow();
    doc.destroy();
  });

  it('initializes editor-compatible title and stable body blocks only on the server', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createSeed());
    expect(() => validateDocument(doc)).not.toThrow();
    expect(doc.getXmlFragment('title').length).toBe(1);
    expect((doc.getXmlFragment('body').get(0) as Y.XmlElement).getAttribute('id')).toBeTruthy();
    doc.destroy();
  });

  it('rejects unsupported marks and heading levels without mutating committed state', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createSeed());
    const body = doc.getXmlFragment('body');
    const block = body.get(0) as Y.XmlElement;
    const text = block.get(0) as Y.XmlText;
    text.format(0, 1, { bold: true });
    expect(() => validateDocument(doc)).toThrow('Only plain text');
    text.format(0, 1, { bold: null });
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('id', 'heading');
    heading.setAttribute('level', '4');
    body.insert(1, [heading]);
    expect(() => validateDocument(doc)).toThrow('Unsupported heading level');
    doc.destroy();
  });

  it('repairs concurrent block deletions with a stable empty paragraph without reseeding title or history', () => {
    const base = new Y.Doc();
    Y.applyUpdate(base, createSeed());
    const second = new Y.XmlElement('paragraph');
    second.setAttribute('id', 'second');
    base.getXmlFragment('body').insert(1, [second]);
    const a = new Y.Doc();
    const b = new Y.Doc();
    const seed = Y.encodeStateAsUpdate(base);
    Y.applyUpdate(a, seed);
    Y.applyUpdate(b, seed);
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
    base.destroy();
    a.destroy();
    b.destroy();
  });
});
