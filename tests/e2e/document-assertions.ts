import { expect, type Locator } from '@playwright/test';

async function documentText(locator: Locator): Promise<string> {
  return locator.evaluate(element => {
    const root = element.closest('[role="textbox"]') as HTMLElement & {
      editor: { state: { doc: { textContent: string; resolve(position: number): { parent: { textContent: string } } } };
        view: { posAtDOM(node: Node, offset: number): number } };
    };
    if (!root?.editor) throw new Error('Expected a mounted editor');
    if (element === root) return root.editor.state.doc.textContent;
    return root.editor.state.doc.resolve(root.editor.view.posAtDOM(element, 0)).parent.textContent;
  });
}

/** Awareness widgets decorate the DOM; these assertions inspect actual editable content. */
export async function expectDocumentText(editor: Locator, text: string): Promise<void> {
  await expect.poll(() => documentText(editor)).toBe(text);
}

export async function expectDocumentContains(editor: Locator, text: string): Promise<void> {
  await expect.poll(() => documentText(editor)).toContain(text);
}

export async function expectDocumentExcludes(editor: Locator, text: string): Promise<void> {
  await expect.poll(() => documentText(editor)).not.toContain(text);
}
