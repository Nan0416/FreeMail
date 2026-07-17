import { FREEMAIL_VERSION } from '@freemail/shared';

export function App(): React.JSX.Element {
  return (
    <main>
      <h1>FreeMail</h1>
      <p>Self-hosted email for agents and humans.</p>
      <p>Version {FREEMAIL_VERSION}</p>
    </main>
  );
}
