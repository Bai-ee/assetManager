import type { Cmd, CmdUpdate } from './control';
import type { SourceInfo } from './store';

export interface PluginContext {
  /** = control.update (use state 'RUNNING' + result.progress for progress). */
  update(u: CmdUpdate): Promise<void>;
  isCancelled(commandId: string): boolean;
  getSource(id: string): SourceInfo | undefined;
}
export interface PluginRouteRequest { method: string; pathname: string; url: URL; body: unknown /* parsed JSON for POST, else undefined */ }
export interface AnalyzerPlugin {
  name: string;
  /** Claimed + run serially by the daemon; added to poll types + heartbeat capabilities. */
  commandTypes: string[];
  run(cmd: Cmd, ctx: PluginContext): Promise<{ result: unknown; cancelled?: boolean }>;
  /** e.g. '/discogs/' */
  routePrefix?: string;
  route?(req: PluginRouteRequest, ctx: { getSource(id: string): SourceInfo | undefined; listSources(): SourceInfo[] }): Promise<{ status: number; body: unknown } | null>;
}
