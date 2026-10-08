import * as path from 'path';
import { AnalyzerControl, type Cmd } from './control';
import { HOME_DIR, runAnalyze } from './analyze';
import { prepareMedia } from './media';
import { makeVision } from './vision';
import { createAnalyzerServer, PORT } from './server';
import { runStage } from './stage';
import { ReadOnlyStore } from './store';
import { DEFAULT_MODEL } from './schema';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class AnalyzerDaemon {
  private stopped = false;
  private cancelled = new Set<string>();
  private queue: Cmd[] = [];
  private queuedIds = new Set<string>();
  private activeId?: string;
  private activeSource?: string;

  constructor(
    private control: AnalyzerControl,
    private store: Pick<ReadOnlyStore, 'listSources' | 'getSource' | 'knownFile'>,
    private opts: { fetchImpl?: typeof fetch; apiKey?: string; handlers?: { analyze?: typeof runAnalyze; stage?: typeof runStage } } = {},
  ) {}

  stop() { this.stopped = true; }
  isCancelled = (id: string) => this.cancelled.has(id);

  async heartbeatAll() {
    for (const s of this.store.listSources()) {
      try { await this.control.heartbeat(s.id, this.activeId && this.activeSource === s.id ? 'PROCESSING' : 'ONLINE', this.activeId); } catch { /* telemetry only */ }
    }
  }

  /** Claim immediately (so the next poll does not re-return it), then run serially. CANCEL_JOB is handled inline. */
  async handlePolled(commands: Cmd[]) {
    for (const cmd of commands) {
      if (this.queuedIds.has(cmd.id) || cmd.id === this.activeId) continue;
      try { await this.control.update({ commandId: cmd.id, state: 'CLAIMED' }); } catch { continue; }
      if (cmd.type === 'CANCEL_JOB') {
        const target = cmd.targetCommandId || cmd.jobId;
        const hit = target ? [target] : [this.activeId, ...this.queue.map(q => q.id)].filter((x): x is string => !!x);
        hit.forEach(id => this.cancelled.add(id));
        await this.control.update({ commandId: cmd.id, state: 'COMPLETE', result: { cancelled: hit } }).catch(() => undefined);
      } else if (cmd.type === 'ANALYZE_FACETS' || cmd.type === 'STAGE_FOR_PUBLISH') {
        this.queue.push(cmd); this.queuedIds.add(cmd.id);
      } else {
        await this.control.update({ commandId: cmd.id, state: 'FAILED', error: `Unsupported command type ${cmd.type}` }).catch(() => undefined);
      }
    }
  }

  async runOne(cmd: Cmd) {
    this.activeId = cmd.id; this.activeSource = cmd.sourceId;
    try {
      if (this.cancelled.has(cmd.id)) { await this.control.update({ commandId: cmd.id, state: 'FAILED', error: 'CANCELLED by owner' }); return; }
      await this.control.update({ commandId: cmd.id, state: 'RUNNING' });
      if (cmd.type === 'ANALYZE_FACETS') {
        const key = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
        const result = await (this.opts.handlers?.analyze ?? runAnalyze)(cmd, {
          store: this.store, control: this.control, prepare: prepareMedia, isCancelled: this.isCancelled,
          apiKey: key, fetchImpl: this.opts.fetchImpl,
          vision: key ? makeVision({ apiKey: key, model: cmd.model || DEFAULT_MODEL, fetchImpl: this.opts.fetchImpl }) : null,
        });
        if (result.cancelled) await this.control.update({ commandId: cmd.id, state: 'FAILED', error: 'CANCELLED by owner', result });
        else await this.control.update({ commandId: cmd.id, state: 'COMPLETE', result });
      } else {
        const result = await (this.opts.handlers?.stage ?? runStage)(cmd, { store: this.store, control: this.control, fetchImpl: this.opts.fetchImpl });
        await this.control.update({ commandId: cmd.id, state: 'COMPLETE', result });
      }
    } catch (e) {
      await this.control.update({ commandId: cmd.id, state: 'FAILED', error: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
    } finally {
      this.queuedIds.delete(cmd.id); this.cancelled.delete(cmd.id); this.activeId = undefined; this.activeSource = undefined;
    }
  }

  async run(pollMs = 3000, heartbeatMs = 30_000) {
    let lastBeat = 0;
    const worker = (async () => {
      while (!this.stopped) {
        const next = this.queue.shift();
        if (next) await this.runOne(next); else await sleep(250);
      }
    })();
    while (!this.stopped) {
      if (Date.now() - lastBeat >= heartbeatMs) { lastBeat = Date.now(); await this.heartbeatAll(); }
      try { await this.handlePolled(await this.control.poll()); } catch { /* HITLOOP briefly unreachable */ }
      await sleep(pollMs);
    }
    await worker;
  }
}

if (process.argv[1]?.endsWith('analyzer/daemon.ts')) {
  const base = process.env.HITLOOP_ARCHIVE_CONTROL_URL, token = process.env.HITLOOP_ARCHIVE_WORKER_TOKEN, wid = process.env.HITLOOP_ARCHIVE_WORKER_ID;
  if (!base || !token || !wid) { console.error('Set HITLOOP_ARCHIVE_CONTROL_URL, HITLOOP_ARCHIVE_WORKER_TOKEN, HITLOOP_ARCHIVE_WORKER_ID'); process.exit(1); }
  const workerId = `${wid}-analyzer`;
  const store = new ReadOnlyStore();
  const server = createAnalyzerServer({
    workerId, thumbDir: path.join(HOME_DIR, 'thumbs'), store,
    // Same dry run the queued "Estimate" command does, answered instantly on this Mac (no cloud round trip, no model calls).
    estimate: ({ sourceId, paths, promptVersion, model, batch }) => runAnalyze(
      { id: 'live-estimate', type: 'ANALYZE_FACETS', sourceId, paths, dryRun: true, ...(batch ? { batch: true } : {}), ...(promptVersion ? { promptVersion } : {}), ...(model ? { model } : {}) },
      { store, control: { update: async () => undefined, pushResults: async () => undefined } as never, vision: null, prepare: prepareMedia, isCancelled: () => false },
    ),
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`analyzer ${workerId} serving http://127.0.0.1:${PORT}`));
  const daemon = new AnalyzerDaemon(new AnalyzerControl(base, token, workerId), store);
  const quit = () => { daemon.stop(); server.close(); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  void daemon.run();
}
