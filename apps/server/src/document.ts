import * as Y from 'yjs';
import { randomUUID } from 'node:crypto';
import { BODY_FRAGMENT, TITLE_FRAGMENT } from '@kikit/contracts';

function paragraph(value: string, id?: string): Y.XmlElement {
  const block = new Y.XmlElement('paragraph');
  if (id) block.setAttribute('id', id);
  const text = new Y.XmlText();
  text.insert(0, value);
  block.insert(0, [text]);
  return block;
}
export function createSeed(): Uint8Array {
  const doc = new Y.Doc();
  doc.getXmlFragment(TITLE_FRAGMENT).insert(0, [paragraph('A little space to think')]);
  doc.getXmlFragment(BODY_FRAGMENT).insert(0, [paragraph('Start with a thought. Make room for the next one.', randomUUID())]);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
export function validateDocument(doc: Y.Doc): void {
  validateSchema(doc, false);
}

/** Repair only a valid CRDT merge that deleted all body blocks. */
export function normalizeEmptyBody(doc: Y.Doc): void {
  validateSchema(doc, true);
  const body = doc.getXmlFragment(BODY_FRAGMENT);
  if (body.length === 0) body.insert(0, [paragraph('', randomUUID())]);
  validateDocument(doc);
}

function validateSchema(doc: Y.Doc, allowEmptyBody: boolean): void {
  if ([...doc.share.keys()].some(key => key !== TITLE_FRAGMENT && key !== BODY_FRAGMENT)) throw new Error('Unsupported document fragment');
  const title = doc.getXmlFragment(TITLE_FRAGMENT);
  const body = doc.getXmlFragment(BODY_FRAGMENT);
  if (title.length !== 1 || (!allowEmptyBody && body.length < 1)) throw new Error('Document requires a title paragraph and body blocks');
  for (const [fragment, isTitle] of [[title, true], [body, false]] as const) {
    for (const block of fragment.toArray()) {
      if (!(block instanceof Y.XmlElement) || !['paragraph', ...(isTitle ? [] : ['heading'])].includes(block.nodeName)) throw new Error('Unsupported block');
      const attrs = block.getAttributes();
      if (Object.keys(attrs).some(key => !(!isTitle && ['id', ...(block.nodeName === 'heading' ? ['level'] : [])].includes(key)))) throw new Error('Unsupported block attribute');
      // ProseMirror stores numeric heading levels in the Yjs attribute map.
      if (block.nodeName === 'heading' && ![1, 2, 3].includes(Number(attrs.level))) throw new Error('Unsupported heading level');
      if (!isTitle && (typeof attrs.id !== 'string' || attrs.id.length < 1 || attrs.id.length > 128)) throw new Error('Body blocks require stable IDs');
      for (const child of block.toArray()) {
        if (!(child instanceof Y.XmlText) || child.toDelta().some((part: { insert: unknown; attributes?: Record<string, unknown> }) => typeof part.insert !== 'string' || Object.keys(part.attributes ?? {}).length)) throw new Error('Only plain text is supported');
      }
    }
  }
  if (Y.encodeStateAsUpdate(doc).byteLength > 2 * 1024 * 1024) throw new Error('Development page exceeds 2 MiB');
}
