import type { RealtimeHub } from "./durable-objects/realtime-hub";
import type { ImportJob } from "./durable-objects/import-job";

export interface Env {
  DB: D1Database;
  SETTINGS_KV: KVNamespace;
  REALTIME: DurableObjectNamespace<RealtimeHub>;
  IMPORT_JOB: DurableObjectNamespace<ImportJob>;
  ASSETS: Fetcher;

  API_SECRET: string;
  SITE_TITLE: string;
  ENABLE: string;
  DISPLAY_UNITS: string;
}
