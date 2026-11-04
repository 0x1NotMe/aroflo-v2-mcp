import { ApiCatalog } from './catalog.js';
import { type Config, loadConfig } from './config.js';
import { SessionContext } from './context.js';
import { AroFloHttp } from './http.js';
import { JobIndex } from './jobs.js';
import type { Deps } from './tools/types.js';

export function makeDeps(cfg: Config = loadConfig(), http: AroFloHttp = new AroFloHttp(cfg), catalog: ApiCatalog = ApiCatalog.load()): Deps {
  return { cfg, catalog, http, ctx: new SessionContext(http, cfg), jobs: new JobIndex(http) };
}
