import { expect, type Page } from '@playwright/test';

export async function openHeaderMenu(page: Page) {
  const trigger = page.getByRole('button', { name: /^(Note|App) menu$/ });
  const menu = page.getByRole('region', { name: /^(Note|App) menu$/ });
  if (!await menu.isVisible()) await trigger.click();
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

export async function clickHeaderAction(page: Page, name: string) {
  await openHeaderMenu(page);
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('region', { name: /^(Note|App) menu$/ })).toBeHidden();
}

/** Save assertions opt into real UI diagnostics; they still require durable receipts. */
export async function showSyncDetails(page: Page) {
  // Reload briefly renders the account shell's App menu before the note mounts.
  // Diagnostics belong to the note; never open that intermediate shell menu.
  await expect(page.getByRole('button', { name: 'Note menu', exact: true })).toBeVisible();
  if (await page.getByTestId('save-status').count()) return;
  await openHeaderMenu(page);
  await page.getByRole('checkbox', { name: 'Show sync details', exact: true }).check();
  await page.keyboard.press('Escape');
}
