import * as Y from 'yjs';
import { randomUUID } from 'node:crypto';
import { BODY_FRAGMENT, TITLE_FRAGMENT } from '@kikit/contracts';
import { validateDocument, validateRepairableDocument } from './document-validation.js';

export { validateDocument } from './document-validation.js';

function createParagraph(value: string, id?: string): Y.XmlElement {
  const block = new Y.XmlElement('paragraph');
  if (id) block.setAttribute('id', id);
  const text = new Y.XmlText();
  text.insert(0, value);
  block.insert(0, [text]);
  return block;
}

export function createSeed(title = 'A little space to think', body = 'Start with a thought. Make room for the next one.'): Uint8Array {
  const doc = new Y.Doc();
  doc.getXmlFragment(TITLE_FRAGMENT).insert(0, [createParagraph(title)]);
  doc.getXmlFragment(BODY_FRAGMENT).insert(0, [
    createParagraph(body, randomUUID()),
  ]);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

export function projectTitle(doc: Y.Doc): string {
  const paragraph = doc.getXmlFragment(TITLE_FRAGMENT).get(0) as Y.XmlElement;
  return paragraph.toArray().map(node => node.toString()).join('').slice(0, 150);
}

/** Repair only otherwise-valid CRDT merges that emptied a required container. */
export function normalizeEmptyBody(doc: Y.Doc): boolean {
  validateRepairableDocument(doc);
  const body = doc.getXmlFragment(BODY_FRAGMENT);
  let repaired = false;
  if (body.length === 0) {
    body.insert(0, [createParagraph('', randomUUID())]);
    repaired = true;
  }
  for (const list of body.toArray()) {
    if (!(list instanceof Y.XmlElement) || list.nodeName !== 'taskList') continue;
    if (list.length === 0) {
      const item = new Y.XmlElement('taskItem');
      item.setAttribute('id', randomUUID());
      item.setAttribute('checked', false as unknown as string);
      list.insert(0, [item]);
      repaired = true;
    }
    for (const item of list.toArray() as Y.XmlElement[]) {
      if (item.length === 0) {
        item.insert(0, [createParagraph('', randomUUID())]);
        repaired = true;
      }
    }
  }
  validateDocument(doc);
  return repaired;
}
