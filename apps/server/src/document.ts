import * as Y from 'yjs';
import { randomUUID } from 'node:crypto';
import { BODY_FRAGMENT, TITLE_FRAGMENT } from '@kikit/contracts';

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

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

export function validateDocument(doc: Y.Doc): void {
  validateSchema(doc, false);
}

/** Repair only a valid CRDT merge that deleted all body blocks. */
export function normalizeEmptyBody(doc: Y.Doc): void {
  validateSchema(doc, true);
  const body = doc.getXmlFragment(BODY_FRAGMENT);
  if (body.length === 0) body.insert(0, [createParagraph('', randomUUID())]);
  validateDocument(doc);
}

function validateSchema(doc: Y.Doc, allowEmptyBody: boolean): void {
  const unsupportedFragment = [...doc.share.keys()]
    .some(key => key !== TITLE_FRAGMENT && key !== BODY_FRAGMENT);
  if (unsupportedFragment) throw new Error('Unsupported document fragment');
  const title = doc.getXmlFragment(TITLE_FRAGMENT);
  const body = doc.getXmlFragment(BODY_FRAGMENT);
  if (title.length !== 1 || (!allowEmptyBody && body.length < 1)) {
    throw new Error('Document requires a title paragraph and body blocks');
  }
  for (const block of title.toArray()) validateBlock(block, true);
  for (const block of body.toArray()) validateBlock(block, false);
  if (Y.encodeStateAsUpdate(doc).byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error('Development page exceeds 2 MiB');
  }
}

function validateBlock(block: unknown, isTitle: boolean): void {
  const allowedNodes = isTitle ? ['paragraph'] : ['paragraph', 'heading'];
  if (!(block instanceof Y.XmlElement) || !allowedNodes.includes(block.nodeName)) {
    throw new Error('Unsupported block');
  }
  const attributes = block.getAttributes();
  const allowedAttributes = isTitle ? [] : ['id', ...(block.nodeName === 'heading' ? ['level'] : [])];
  if (Object.keys(attributes).some(key => !allowedAttributes.includes(key))) {
    throw new Error('Unsupported block attribute');
  }
  // ProseMirror stores numeric heading levels in the Yjs attribute map.
  if (block.nodeName === 'heading' && ![1, 2, 3].includes(Number(attributes.level))) {
    throw new Error('Unsupported heading level');
  }
  if (!isTitle && (
    typeof attributes.id !== 'string' || attributes.id.length < 1 || attributes.id.length > 128
  )) {
    throw new Error('Body blocks require stable IDs');
  }
  for (const child of block.toArray()) validatePlainText(child);
}

function validatePlainText(child: unknown): void {
  if (!(child instanceof Y.XmlText)) throw new Error('Only plain text is supported');
  const unsupportedText = child.toDelta().some((part: {
    insert: unknown;
    attributes?: Record<string, unknown>;
  }) => typeof part.insert !== 'string' || Object.keys(part.attributes ?? {}).length > 0);
  if (unsupportedText) throw new Error('Only plain text is supported');
}
