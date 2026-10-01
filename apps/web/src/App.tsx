import { DocumentPage } from './components/DocumentPage';
import { useDocumentSession } from './session/useDocumentSession';

export default function App() {
  const { session, snapshot } = useDocumentSession();

  return <DocumentPage session={session} snapshot={snapshot} />;
}
