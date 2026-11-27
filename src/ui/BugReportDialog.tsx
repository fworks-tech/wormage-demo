import { useState } from 'react';
import { BugReportUnavailableError, ReportTooLargeError, createBugReportId } from '../api/bugReport';
import type { GameScreenshot } from '../api/types';
import { CaptureError } from './screenCapture';

interface BugReportDialogProps {
  onCapture: () => Promise<GameScreenshot>;
  onSend: (input: { note: string; screenshot: GameScreenshot | null; reportId: string }) => Promise<string>;
  onClose: () => void;
}

type Busy = 'capture' | 'send' | null;

function captureMessage(err: unknown): string {
  if (err instanceof CaptureError) {
    switch (err.code) {
      case 'unsupported':
        return 'This browser cannot capture a tab. Send the report without a screenshot.';
      case 'denied':
        return 'Screen capture was cancelled. Try again or send the report without a screenshot.';
      case 'wrong-surface':
        return 'Share this tab, not a window or the screen. If your browser cannot confirm the tab, send the report without a screenshot.';
      default:
        return 'The screenshot could not be captured. Try again or send without it.';
    }
  }
  return 'The screenshot could not be captured. Try again or send without it.';
}

/** Bug report card; the parent hides the pause overlay while `onCapture` runs. */
export function BugReportDialog({ onCapture, onSend, onClose }: BugReportDialogProps) {
  const [note, setNote] = useState('');
  const [screenshot, setScreenshot] = useState<GameScreenshot | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const [reportId] = useState(createBugReportId);

  const capture = async () => {
    setBusy('capture');
    setError(null);
    try {
      setScreenshot(await onCapture());
    } catch (err) {
      setError(captureMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy('send');
    setError(null);
    try {
      setSentId(await onSend({ note, screenshot, reportId }));
    } catch (err) {
      if (err instanceof ReportTooLargeError) {
        setError('This report is too large to send. Try again without the screenshot.');
      } else if (err instanceof BugReportUnavailableError) {
        setError('Bug reporting is temporarily unavailable. Please try again later.');
      } else {
        setError('The report could not be sent. Check your connection and try again.');
      }
    } finally {
      setBusy(null);
    }
  };

  if (sentId) {
    return (
      <div className="overlay-card bug-report-dialog" data-testid="bug-report-dialog">
        <p className="eyebrow">Support</p>
        <h2>Report sent</h2>
        <p className="muted" data-testid="report-sent">
          Reference <span className="mono">{sentId}</span>. The seed, state and screenshot are on their way.
        </p>
        <div className="overlay-actions">
          <button type="button" className="primary-btn" onClick={onClose} data-testid="btn-close-report">
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay-card bug-report-dialog" data-testid="bug-report-dialog">
      <p className="eyebrow">Support</p>
      <h2>Report a bug</h2>
      <p className="muted">
        Sends this match&apos;s seed, settings, state and logs, plus the page URL, browser info and a screenshot of the
        game without this menu. A short summary may be posted to a public GitHub issue. Do not include personal information.
      </p>

      {screenshot ? (
        <div className="report-preview">
          <img src={screenshot.dataUrl} alt="Captured game screen" data-testid="report-preview" />
          <small className="muted mono">
            {screenshot.width}×{screenshot.height} · {screenshot.mime === 'image/png' ? 'PNG' : 'JPEG'} ·{' '}
            {Math.round(screenshot.bytes / 1024)} KB
          </small>
        </div>
      ) : (
        <p className="muted">The browser will ask to share this tab. Pick this tab, not a window or the screen.</p>
      )}

      <div className="dialog-form">
        <label htmlFor="report-note">
          <span>What happened?</span>
          <small>Optional. Anything the screenshot does not show.</small>
        </label>
        <textarea
          id="report-note"
          className="report-note"
          value={note}
          maxLength={2000}
          onChange={(event) => setNote(event.target.value)}
          data-testid="report-note"
        />
      </div>

      <div className="overlay-actions">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void capture()}
          disabled={busy !== null}
          data-testid="btn-capture-report"
        >
          {busy === 'capture' ? 'Capturing…' : screenshot ? 'Retake' : 'Capture screen'}
        </button>
        <button
          type="button"
          className="primary-btn"
          onClick={() => void send()}
          disabled={busy !== null}
          data-testid="btn-send-report"
        >
          {busy === 'send' ? 'Sending…' : 'Send report'}
        </button>
        <button type="button" className="ghost-btn" onClick={onClose} data-testid="btn-cancel-report">
          Cancel
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert" data-testid="report-error">
          {error}
        </p>
      )}
    </div>
  );
}
