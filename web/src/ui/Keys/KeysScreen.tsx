// web/src/ui/Keys/KeysScreen.tsx
//
// Part 3.10's key / firmware manager.
//
// The governing rule from Part 0: "Never display or log key material." This
// screen is the most likely place for that rule to be broken by accident, since it
// is where a user comes to inspect their key setup. So the screen shows *derived
// facts* — how many keys of each family, how many rights IDs, whether the file
// parses — and has no code path that can put a key value on screen.
//
// "Re-derive without a reload" is also part of the spec, and it is honest here to
// say why it does nothing yet: key derivation happens during mount (Phase 2), so
// there is nothing cached to invalidate.

import { useCallback, useState } from 'react';
import { Card, Pill } from '../components';
import { EmulatorPaths } from '../../platform/paths';
import type { KeysSummaryMessage } from '../../platform/protocol';

interface KeysScreenProps {
  folderName: string | null;
  summary: KeysSummaryMessage | null;
  onPickKeys: () => void;
  busy: boolean;
  onClearKeys: () => void;
}

export function KeysScreen({ folderName, summary, onPickKeys, busy, onClearKeys }: KeysScreenProps) {
  const [firmwareNote, setFirmwareNote] = useState<string | null>(null);

  const handlePickFirmware = useCallback(async () => {
    const picker = showOpenFilePicker;
    if (typeof picker !== 'function') {
      setFirmwareNote(
        'This browser does not implement showOpenFilePicker. Firmware can only be supplied by placing it in the firmware/ folder of your chosen directory.',
      );
      return;
    }
    try {
      // `picker` is captured into a local before the guard so the narrowing
      // survives the awaits below; narrowing a global does not.
      const [handle] = await picker({
        multiple: false,
        types: [{ description: 'Switch firmware image', accept: { 'application/octet-stream': ['.bin'] } }],
      });
      if (!handle) return;
      // Phase 0 does not parse or retain firmware. Model A boot (Part 3.4) does
      // not execute boot2, so firmware is optional and unparsed at this point.
      const file = await handle.getFile();
      setFirmwareNote(
        `Selected "${file.name}" (${(file.size / 1024 ** 2).toFixed(1)} MiB). Firmware is not parsed in this build and was not retained.`,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setFirmwareNote(null);
        return;
      }
      setFirmwareNote(error instanceof Error ? error.message : String(error));
    }
  }, []);

  return (
    <>
      <h2>Keys and firmware</h2>
      <p className="lede">
        switch-web contains no keys and no firmware, and never will. Both are yours to supply from
        hardware you own, and neither is uploaded, displayed, or logged.
      </p>

      <Card
        title="prod.keys"
        badge={
          summary ? (
            summary.valid ? (
              <Pill tone="ok">valid</Pill>
            ) : (
              <Pill tone="err">invalid</Pill>
            )
          ) : (
            <Pill tone="muted">not supplied</Pill>
          )
        }
      >
        <p>
          Required to mount encrypted content. Read through a file picker, validated by shape, and
          held in memory only for the duration of a mount. Values are never surfaced anywhere in this
          interface.
        </p>

        <div className="btn-row">
          <button className="btn btn-primary" onClick={onPickKeys} disabled={busy}>
            {busy ? 'Reading…' : summary ? 'Choose a different file' : 'Choose keys file'}
          </button>
          {summary && <button className="btn" onClick={onClearKeys}>Forget</button>}
        </div>

        {folderName && (
          <p className="field-hint" style={{ marginTop: 10 }}>
            Alternatively, place a file at <code>{EmulatorPaths.keysFile}</code> inside your folder.
          </p>
        )}

        {summary && (
          <>
            <h3>Derived summary</h3>
            <table>
              <tbody>
                <tr>
                  <td className="muted">File</td>
                  <td className="num">{summary.fileName}</td>
                </tr>
                <tr>
                  <td className="muted">Size</td>
                  <td className="num">{summary.byteLength} bytes</td>
                </tr>
                <tr>
                  <td className="muted">128-bit key entries</td>
                  <td className="num">{summary.keyLineCount}</td>
                </tr>
                <tr>
                  <td className="muted">rights_id entries</td>
                  <td className="num">{summary.rightsIdCount}</td>
                </tr>
                <tr>
                  <td className="muted">Key families</td>
                  <td className="num">{summary.families.join(', ') || 'none'}</td>
                </tr>
              </tbody>
            </table>

            <div className="callout callout-info" style={{ marginTop: 12 }}>
              <div className="callout-title">Why rights_id matters</div>
              <div className="callout-body">
                <p>
                  Content is refused unless its <code>rights_id</code> appears in your key file. This
                  matches hardware behaviour and is intentional: the app does not &ldquo;fix&rdquo;
                  region locks or work around them.
                </p>
              </div>
            </div>

            {summary.problems.length > 0 && (
              <div className="callout callout-warn" style={{ marginTop: 12 }}>
                <div className="callout-title">Issues found</div>
                <div className="callout-body">
                  <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                    {summary.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </>
        )}

        <h3>Re-derive</h3>
        <p className="field-hint">
          &ldquo;Re-derive without a reload&rdquo; has nothing to do yet. Key derivation runs during
          content mount in Phase 2, and no derived schedule is cached in this build.
        </p>
        <button className="btn" disabled>
          Re-derive keys (nothing derived yet)
        </button>
      </Card>

      <Card title="Firmware" badge={<Pill tone="muted">optional</Pill>}>
        <p>
          Not required. This build uses the Part 3.4 Model A boot path: an HLE kernel is synthesised
          and the second-stage bootloader is never executed. Firmware would only be consulted later for
          certificate stores.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={() => void handlePickFirmware()}>
            Choose firmware image
          </button>
        </div>
        {firmwareNote && (
          <div className="callout callout-info" style={{ marginTop: 12 }}>
            <div className="callout-body">{firmwareNote}</div>
          </div>
        )}
      </Card>

      <Card title="What this app will never do">
        <ul className="dim" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Ship a title key, a master key, or any key blob, for any title.</li>
          <li>Fetch keys or firmware from any location, including first run.</li>
          <li>Display, log, or export key material, at any verbosity.</li>
          <li>Identify a specific title in order to acquire its keys.</li>
          <li>Write anything outside your chosen folder, apart from a handle pointer.</li>
        </ul>
      </Card>
    </>
  );
}
