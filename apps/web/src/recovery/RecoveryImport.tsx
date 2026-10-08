import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import { MAX_RECOVERY_FILE_BYTES, parseRecoveryFile, type PageSummary } from '@kikit/contracts';
import type { DocumentSession } from '../session';
import { containDialogFocus } from '../components/dialog-focus';
import { checkRecoveryAccess, recoverCopy } from './client';

export function RecoveryImport({ accountId, pageId, session, disabled, onRecovered }: {
  accountId: string; pageId?: string; session?: DocumentSession; disabled?: boolean; onRecovered(page: PageSummary): void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" disabled={disabled} onClick={() => setOpen(true)}>Import recovery file</button>
    {open && createPortal(<ImportDialog key={accountId} accountId={accountId} pageId={pageId} session={session}
      onClose={() => setOpen(false)} onRecovered={page => { setOpen(false); onRecovered(page); }} />, document.body)}
  </>;
}

function ImportDialog({ accountId, pageId, session, onClose, onRecovered }: {
  accountId: string; pageId?: string; session?: DocumentSession; onClose(): void; onRecovered(page: PageSummary): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const destination = useRef(crypto.randomUUID());
  const selection = useRef(0);
  const [file, setFile] = useState<{ text: string; name: string; title: string; pageId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => {
      selection.current++;
      dialog.current?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  async function select(input: File | undefined) {
    const current = ++selection.current;
    setFile(null); setError(null);
    if (!input) return;
    try {
      if (input.size > MAX_RECOVERY_FILE_BYTES) throw new Error('This recovery file is too large. Keep the original file.');
      const text = await input.text();
      const parsed = parseRecoveryFile(text, { accountId });
      if (current !== selection.current) return;
      destination.current = crypto.randomUUID();
      setFile({ text, name: input.name, title: parsed.title, pageId: parsed.pageId });
    } catch (cause) { if (current === selection.current) setError(message(cause)); }
  }
  async function recover(copy: boolean) {
    if (!file) return;
    const request = selection.current;
    setBusy(true); setError(null);
    try {
      if (copy) {
        const page = await recoverCopy(destination.current, file.text, accountId);
        if (request === selection.current) onRecovered(page);
      }
      else {
        const committed = await checkRecoveryAccess(pageId!, accountId);
        if (request !== selection.current) return;
        await session!.importRecovery(file.text, committed);
        if (request === selection.current) onClose();
      }
    } catch (cause) { if (request === selection.current) setError(message(cause)); }
    finally { if (request === selection.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="leave-dialog recovery-dialog" aria-labelledby="import-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={containDialogFocus}>
    <h2 id="import-title">Import recovery file</h2>
    <p>Choose a recovery file from this account. The original file is kept.</p>
    <label className="recovery-file">Recovery file<input type="file" accept=".json,application/json" disabled={busy}
      onChange={event => { void select(event.target.files?.[0]); }} /></label>
    {file && <p className="recovery-file-summary">{file.name}<br />{file.title || 'Untitled note'}</p>}
    {file && <p>{session && file.pageId === pageId
      ? 'Merge keeps existing edits and sends recovered changes through normal synchronization.'
      : 'To merge into the original note, open it and import this file there.'} A new copy is private.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="notice-actions">
      <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
      {session && file?.pageId === pageId && <button type="button" disabled={busy} onClick={() => { void recover(false); }}>Merge into this note</button>}
      <button type="button" className="primary-button" disabled={busy || !file} onClick={() => { void recover(true); }}>
        {busy ? 'Recovering…' : 'Recover new private copy'}
      </button>
    </div>
  </dialog>;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Recovery failed. Keep the file and try again.'; }
