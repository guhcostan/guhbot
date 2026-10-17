import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import type { Device } from '@guhbot/protocol';
import type { HostApi } from './api.js';
import { errorMessage } from './api.js';

export function HostDialogs({
  kind,
  api,
  onClose,
}: {
  kind: 'agent' | 'devices' | 'connect';
  api: HostApi;
  onClose: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState('');
  const [url, setUrl] = useState('ws://127.0.0.1:8787/rpc');
  const [token, setToken] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairing, setPairing] = useState<{
    pairingId: string;
    code: string;
    expiresAt: string;
  } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
    if (kind !== 'devices') dialog.current?.querySelector('input')?.focus();
    if (kind === 'devices')
      void api
        .listDevices()
        .then(setDevices)
        .catch((e: unknown) => setError(errorMessage(e)));
  }, [kind, api.listDevices]);

  useEffect(() => {
    if (!pairing || !api.connectionUrl) return;
    let current = true;
    const endpoint = new URL(api.connectionUrl);
    const params = new URLSearchParams({
      host: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'wss:' ? '443' : '80'),
      id: pairing.pairingId,
      code: pairing.code,
    });
    if (endpoint.protocol === 'wss:') params.set('secure', '1');
    if (endpoint.pathname !== '/rpc') params.set('path', endpoint.pathname);
    void import('qrcode')
      .then((module) =>
        module.toDataURL(`guhbot://pair?${params}`, {
          width: 180,
          margin: 2,
          color: { dark: '#25232e', light: '#ffffff' },
        }),
      )
      .then((value) => {
        if (current) setQr(value);
      })
      .catch(() => {
        if (current) setQr(null);
      });
    return () => {
      current = false;
    };
  }, [pairing, api.connectionUrl]);

  const work = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void work(async () => {
      if (kind === 'agent') {
        if (await api.createAgent(name, instructions, model)) onClose();
        else
          setError(
            'Could not create this bot. Check the connection and try again.',
          );
      } else {
        api.connectHost(url.trim(), token.trim());
        onClose();
      }
    });
  };

  return (
    <dialog
      ref={dialog}
      className="host-dialog"
      onCancel={onClose}
      aria-labelledby="dialog-title"
    >
      <div className="dialog-heading">
        <h2 id="dialog-title">
          {kind === 'agent'
            ? 'Create a bot'
            : kind === 'devices'
              ? 'Devices & pairing'
              : 'Connect to a host'}
        </h2>
        <button
          type="button"
          className="action-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          Close
        </button>
      </div>
      {error ? (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      ) : null}
      {kind === 'devices' ? (
        <>
          <p>
            A new phone starts with viewing access. Grant operator access only
            to a device you control. Operators can send tasks, approve actions
            and manage other devices.
          </p>
          <p className="dialog-note">
            Connection address:{' '}
            <code>{api.connectionUrl ?? 'Not connected'}</code>
          </p>
          <button
            className="action-button primary-action"
            type="button"
            disabled={busy || api.state.deviceClass !== 'person'}
            onClick={() =>
              void work(async () => {
                setPairing(await api.beginPairing());
                setDevices(await api.listDevices());
              })
            }
          >
            Pair a phone
          </button>
          {pairing ? (
            <div className="pairing-details">
              {qr ? (
                <img
                  src={qr}
                  width="180"
                  height="180"
                  alt="Scan to pair your phone with this host"
                />
              ) : null}
              <label>
                Pairing ID<code>{pairing.pairingId}</code>
              </label>
              <label>
                Pairing code<strong>{pairing.code}</strong>
              </label>
              <p>
                Expires {new Date(pairing.expiresAt).toLocaleTimeString()}.
                Enter these in the mobile app with your host address and port.
              </p>
            </div>
          ) : null}
          <button
            className="action-button"
            type="button"
            disabled={busy}
            onClick={() =>
              void work(async () => setDevices(await api.listDevices()))
            }
          >
            Refresh devices
          </button>
          <div className="device-list">
            {devices
              .filter((d) => !d.revokedAt)
              .map((device) => (
                <article key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <span>
                      {device.platform} ·{' '}
                      {device.class === 'person' ? 'Operator' : 'Viewer'}
                    </span>
                  </div>
                  {device.platform !== 'desktop' &&
                  device.platform !== 'cli' &&
                  api.state.deviceClass === 'person' ? (
                    <div className="device-actions">
                      <button
                        className="action-button"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void work(async () => {
                            await api.setDeviceAccess(
                              device.id,
                              device.class === 'person'
                                ? 'background'
                                : 'person',
                            );
                            setDevices(await api.listDevices());
                          })
                        }
                      >
                        {device.class === 'person'
                          ? 'Make viewer'
                          : 'Grant operator access'}
                      </button>
                      <button
                        className="action-button"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void work(async () => {
                            await api.revokeDevice(device.id);
                            setDevices(await api.listDevices());
                          })
                        }
                      >
                        Revoke
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
          </div>
          <p className="dialog-note">
            After an access change, tap Reconnect in the mobile app. Revocation
            takes effect on the host immediately. Remote access requires a TLS
            proxy or a private VPN.
          </p>
        </>
      ) : (
        <form onSubmit={submit}>
          {kind === 'agent' ? (
            <>
              <label>
                Bot name
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Research"
                />
              </label>
              <label>
                Instructions
                <textarea
                  maxLength={100000}
                  rows={4}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="What should this bot help you with?"
                />
              </label>
              <label>
                Model (optional)
                <input
                  maxLength={200}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="Use the host default"
                />
              </label>
            </>
          ) : (
            <>
              <p>
                Connect to your own computer or a hosted Guh Bot. Your token
                stays in this window's memory.
              </p>
              <label>
                Host WebSocket URL
                <input
                  autoFocus
                  required
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="wss://your-host.example/rpc"
                />
              </label>
              <label>
                Device token
                <input
                  required
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <p className="dialog-note">
                Use the operator token on your own host, or a tenant token
                issued by your hosting operator. Remote connections require
                wss://. Localhost also accepts ws://.
              </p>
            </>
          )}
          <button
            className="action-button primary-action"
            disabled={busy || (kind === 'agent' && !name.trim())}
            type="submit"
          >
            {busy ? 'Working…' : kind === 'agent' ? 'Create bot' : 'Connect'}
          </button>
        </form>
      )}
    </dialog>
  );
}
