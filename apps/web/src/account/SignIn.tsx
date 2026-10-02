import { useState, type FormEvent } from 'react';
import { AppHeader } from '../components/AppHeader';
import { authClient } from './client';

export function SignIn({ continuation = '/' }: { continuation?: '/' | '/#/join' }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(() => new URLSearchParams(location.search).has('error') ? 'This sign-in link is invalid or expired. Request a new one.' : null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setState('sending'); setError(null);
    try {
      const result = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: continuation, errorCallbackURL: continuation });
      if (result.error) throw new Error('Could not send the sign-in email. Please try again shortly.');
      setState('sent');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send the sign-in email.'); setState('idle'); }
  }
  return <div className="app-shell">
    <AppHeader>{null}</AppHeader>
    <main className="account-panel">
      <h1>Sign in to Kikit</h1>
      <p>Enter your email to receive a sign-in link.</p>
      {continuation === '/#/join' && <p>Sign in, then choose whether to join the shared note. Return to your invitation if it does not reopen.</p>}
      <form onSubmit={event => { void submit(event); }}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={event => { setEmail(event.target.value); setState('idle'); }} />
        <button className="primary-button" disabled={state === 'sending'}>{state === 'sending' ? 'Sending…' : 'Send sign-in link'}</button>
      </form>
      {state === 'sent' && <p role="status">Check your inbox. The link expires in 10 minutes.</p>}
      {error && <p className="account-error" role="alert">{error}</p>}
    </main>
  </div>;
}
