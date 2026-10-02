// web/src/ui/Onboarding/OnboardingScreen.tsx
//
// Part 3.10's onboarding wizard: "a first-run wizard — folder -> keys -> game —
// that states the legal boundaries up front."
//
// Part 0 makes the ordering itself a requirement: "First-run UI states the user
// must own the game; 'I own this game' checkbox gates install scanning." So the
// attestation comes *before* the folder picker, not after it. A user who has not
// acknowledged the boundary cannot reach a file picker.

import { useState } from 'react';
import { Callout, Card, Pill } from '../components';
import { EXPECTED_LAYOUT } from '../Library/LibraryScreen';

interface OnboardingScreenProps {
  folderName: string | null;
  keysFileName: string | null;
  keysValid: boolean | null;
  folderBusy: boolean;
  keysBusy: boolean;
  onPickFolder: () => void;
  onPickKeys: () => void;
  onFinish: () => void;
}

type Step = 'attest' | 'folder' | 'keys' | 'game' | 'done';

const STEP_ORDER: Step[] = ['attest', 'folder', 'keys', 'game', 'done'];

const STEP_LABELS: Record<Step, string> = {
  attest: 'Obligations',
  folder: 'Folder',
  keys: 'Keys',
  game: 'Game',
  done: 'Ready',
};

export function OnboardingScreen({
  folderName,
  keysFileName,
  keysValid,
  folderBusy,
  keysBusy,
  onPickFolder,
  onPickKeys,
  onFinish,
}: OnboardingScreenProps) {
  const [attested, setAttested] = useState(false);
  const [step, setStep] = useState<Step>('attest');

  const advance = (next: Step) => setStep(STEP_ORDER[Math.min(STEP_ORDER.indexOf(next) + 1, STEP_ORDER.length - 1)]!);
  const stepIndex = STEP_ORDER.indexOf(step);

  return (
    <>
      <h2>Set up switch-web</h2>
      <p className="lede">
        Four short steps. The emulator runs entirely on your device: nothing you provide is uploaded,
        and no game content is fetched by this app.
      </p>

      <ol className="nav-steps" style={{ display: 'flex', gap: 8, listStyle: 'none', padding: 0, margin: '16px 0' }}>
        {STEP_ORDER.map((s, i) => {
          const state = i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo';
          return (
            <li key={s} className={`step-chip step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="step-index">{i + 1}</span>
              {STEP_LABELS[s]}
            </li>
          );
        })}
      </ol>

      {step === 'attest' && (
        <Card title="Your obligations">
          <Callout tone="warn" title="You must own the game you play">
            <p>
              switch-web is a generic content-mounting path. It contains no keys, no firmware, no ROMs,
              and no title-specific data of any kind. You supply content you dumped from hardware you
              own, and you are responsible for complying with the law that applies where you live.
            </p>
          </Callout>

          <p>
            Concretely, this app will never:
          </p>
          <ul className="dim" style={{ margin: '0 0 14px', paddingLeft: 20 }}>
            <li>download, bundle, or fetch any game, firmware, or key material;</li>
            <li>make any network request at runtime beyond loading its own interface;</li>
            <li>display or log your key material, at any point;</li>
            <li>circumvent any access control on content you do not have the right to.</li>
          </ul>

          <div className="checkbox-row">
            <input
              id="attest-own"
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
            <label htmlFor="attest-own">
              I own the games I will run, and I understand that online features are unavailable in this
              build.
            </label>
          </div>

          <button className="btn btn-primary" disabled={!attested} onClick={() => advance('folder')}>
            Continue
          </button>
        </Card>
      )}

      {step === 'folder' && (
        <Card
          title="Choose a folder"
          badge={folderName ? <Pill tone="ok">done</Pill> : <Pill tone="accent">required</Pill>}
        >
          <p>
            Everything this app writes — saves, save states, shader cache, JIT code cache — goes into a
            folder you pick. Nothing is written outside it.
          </p>

          <div className="btn-row">
            <button className="btn btn-primary" onClick={onPickFolder} disabled={folderBusy}>
              {folderBusy ? 'Opening…' : folderName ? 'Choose a different folder' : 'Choose folder'}
            </button>
            {folderName && <Pill tone="ok">{folderName}</Pill>}
          </div>

          <h3>What will be created there</h3>
          <div className="path-tree">
            {EXPECTED_LAYOUT.map((line) => (
              <div key={line.path}>
                {line.path}
                <span className="muted" style={{ marginLeft: 12 }}>
                  {line.purpose}
                </span>
              </div>
            ))}
          </div>

          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => setStep('attest')}>
              Back
            </button>
            <button className="btn btn-primary" disabled={!folderName} onClick={() => advance('keys')}>
              Continue
            </button>
          </div>
        </Card>
      )}

      {step === 'keys' && (
        <Card
          title="Supply your keys"
          badge={keysFileName ? <Pill tone={keysValid ? 'ok' : 'err'}>{keysValid ? 'valid' : 'invalid'}</Pill> : <Pill tone="muted">optional</Pill>}
        >
          <p>
            Encrypted content cannot be mounted without the keys that decrypt it. The file is read
            through a picker, validated by shape, and held in memory only. It is never uploaded,
            displayed, logged, or written to browser storage.
          </p>

          <Callout tone="info" title="Firmware is optional">
            <p>
              This build uses the Part 3.4 Model A boot path: an HLE kernel is synthesised and the
              second-stage bootloader is not executed. Firmware is therefore optional and is only
              consulted later for certificate stores.
            </p>
          </Callout>

          <div className="btn-row">
            <button className="btn btn-primary" onClick={onPickKeys} disabled={keysBusy}>
              {keysBusy ? 'Reading…' : keysFileName ? 'Choose a different keys file' : 'Choose keys file'}
            </button>
            {keysFileName && <Pill tone={keysValid ? 'ok' : 'err'}>{keysFileName}</Pill>}
          </div>

          <p className="field-hint" style={{ marginTop: 10 }}>
            You can also place a file at <code>{EXPECTED_LAYOUT[1]?.path}prod.keys</code> in your chosen
            folder.
          </p>

          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => setStep('folder')}>
              Back
            </button>
            <button className="btn btn-primary" onClick={() => advance('game')}>
              {keysFileName ? 'Continue' : 'Skip for now'}
            </button>
          </div>
        </Card>
      )}

      {step === 'game' && (
        <Card title="Add your game">
          <p>
            Copy a legally-dumped <code>.xci</code>, <code>.nsp</code>, <code>.nca</code>, or{' '}
            <code>.nso</code> into the <code>games/</code> folder in your chosen directory.
          </p>

          <Callout tone="info" title="Nothing will appear in the library yet">
            <p>
              Container parsing and RomFS construction are Part 3.1 work, which is Phase 1. No file in
              <code> games/</code> is read by this build yet — not even its name.
            </p>
          </Callout>

          <div className="btn-row">
            <button className="btn" onClick={() => setStep('keys')}>
              Back
            </button>
            <button className="btn btn-primary" onClick={onFinish}>
              Finish setup
            </button>
          </div>
        </Card>
      )}
    </>
  );
}
