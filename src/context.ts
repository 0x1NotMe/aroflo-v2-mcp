import type { Config } from './config.js';
import { ApiError, type AroFloHttp } from './http.js';
import { isObj } from './format.js';
import type { BusinessUnitSource } from './request.js';

/** Session facts fetched once and reused, so the model never spends a call looking them up. */
export class SessionContext implements BusinessUnitSource {
  private bu?: Promise<string>;

  constructor(
    private readonly http: AroFloHttp,
    private readonly cfg: Config
  ) {}

  /** AROFLO_V2_BUSINESS_UNIT_ID, else the first business unit the token can see. */
  businessUnitId(): Promise<string> {
    if (this.cfg.businessUnitId) return Promise.resolve(this.cfg.businessUnitId);
    this.bu ??= (async () => {
      const res = await this.http.request('GET', '/businessunits', { query: { _fields: 'id', limit: '1' }, collection: true, template: 'GET /businessunits' });
      const first = isObj(res.data) && Array.isArray(res.data.items) ? res.data.items[0] : undefined;
      if (!isObj(first) || typeof first.id !== 'string') throw new ApiError('The token sees no business unit; check its AroFlo user has business-unit access.', 0);
      return first.id;
    })();
    this.bu.catch(() => {
      this.bu = undefined;
    });
    return this.bu;
  }
}
