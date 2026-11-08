import { useState, type JSX } from 'react';
import { ApiError } from '../../api/client';
import { createProject, type Project } from '../../api/projects';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';

/**
 * New project dialog.
 *
 * Validation mirrors the backend on purpose: the same rules run in both places,
 * so the form explains the problem immediately while the server stays the
 * authority (a hand-crafted request still gets a 400).
 */

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project, webhookSecret: string) => void;
}

const REPO_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+?(?:\.git)?$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function NewProjectModal({ open, onClose, onCreated }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [dockerfilePath, setDockerfilePath] = useState('Dockerfile');
  const [containerPort, setContainerPort] = useState('80');
  const [token, setToken] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [memory, setMemory] = useState('512');
  const [cpu, setCpu] = useState('0.5');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const nameError = name !== '' && !NAME_PATTERN.test(name) ? 'Lowercase letters, digits and dashes, 3–64 characters.' : null;
  const repoError = repoUrl !== '' && !REPO_PATTERN.test(repoUrl) ? 'Use https://github.com/owner/repo' : null;
  const portError = !/^\d+$/.test(containerPort) || Number(containerPort) < 1 || Number(containerPort) > 65535
    ? 'Port must be between 1 and 65535.'
    : null;

  const canSubmit =
    NAME_PATTERN.test(name) &&
    REPO_PATTERN.test(repoUrl) &&
    branch.trim() !== '' &&
    dockerfilePath.trim() !== '' &&
    portError === null &&
    !working;

  const submit = async (): Promise<void> => {
    setWorking(true);
    setError(null);

    try {
      const result = await createProject({
        name,
        repoUrl,
        branch: branch.trim(),
        dockerfilePath: dockerfilePath.trim(),
        containerPort: Number(containerPort),
        memoryLimitMb: Number(memory) || undefined,
        cpuLimit: Number(cpu) || undefined,
        ...(token.trim() ? { token: token.trim() } : {}),
      });

      onCreated(result.project, result.webhookSecret);
      // Reset for the next project.
      setName('');
      setRepoUrl('');
      setToken('');
      setAdvanced(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the project');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal
      open={open}
      title="New project"
      onClose={onClose}
      footer={
        <div className="modal-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {working ? 'Creating…' : 'Create project'}
          </Button>
        </div>
      }
    >
      <div className="form">
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="input"
            value={name}
            placeholder="my-site"
            autoFocus
            onChange={(event) => setName(event.target.value.toLowerCase())}
          />
          {nameError ? <span className="field__error">{nameError}</span> : null}
          <span className="field__hint">Used for the container name, the image tag and the slug.</span>
        </label>

        <label className="field">
          <span className="field__label">Repository</span>
          <input
            className="input"
            value={repoUrl}
            placeholder="https://github.com/owner/repo"
            onChange={(event) => setRepoUrl(event.target.value.trim())}
          />
          {repoError ? <span className="field__error">{repoError}</span> : null}
          <span className="field__hint">HTTPS GitHub URLs only. SSH and other schemes are rejected.</span>
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field__label">Branch</span>
            <input className="input" value={branch} onChange={(event) => setBranch(event.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Container port</span>
            <input
              className="input"
              value={containerPort}
              inputMode="numeric"
              onChange={(event) => setContainerPort(event.target.value)}
            />
            {portError ? <span className="field__error">{portError}</span> : null}
          </label>
        </div>

        <label className="field">
          <span className="field__label">Dockerfile path</span>
          <input
            className="input"
            value={dockerfilePath}
            onChange={(event) => setDockerfilePath(event.target.value)}
          />
          <span className="field__hint">Relative to the repository root. Required — nothing is generated for you.</span>
        </label>

        <label className="field">
          <span className="field__label">GitHub token (private repositories)</span>
          <input
            className="input"
            type="password"
            value={token}
            placeholder="ghp_… (optional)"
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
          />
          <span className="field__hint">
            Stored encrypted and never shown again. Leave empty for public repositories.
          </span>
        </label>

        <button type="button" className="link-button" onClick={() => setAdvanced((value) => !value)}>
          {advanced ? 'Hide resource limits' : 'Resource limits'}
        </button>

        {advanced ? (
          <div className="field-row">
            <label className="field">
              <span className="field__label">Memory (MB)</span>
              <input className="input" value={memory} inputMode="numeric" onChange={(event) => setMemory(event.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">CPU cores</span>
              <input className="input" value={cpu} inputMode="decimal" onChange={(event) => setCpu(event.target.value)} />
            </label>
          </div>
        ) : null}

        {error ? <div className="form-error">{error}</div> : null}
      </div>
    </Modal>
  );
}
