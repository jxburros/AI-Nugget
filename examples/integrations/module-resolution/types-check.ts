// Type-only consumer fixture for verify.mjs: compiled with `tsc --noEmit` under
// several moduleResolution modes. Under classic `node10` resolution (the
// default for `module: commonjs`), the `/agent` subpath's types are reachable
// only through package.json `typesVersions` — `exports` is invisible there.
import { AIHandler, envKeySource } from '@jxburros/ai-nugget';
import { defineTool, runAgent } from '@jxburros/ai-nugget/agent';
import type { AgentEvent } from '@jxburros/ai-nugget/agent';

export const handler: AIHandler = new AIHandler({ keySource: envKeySource() });
export const entryPoints: [typeof runAgent, typeof defineTool] = [runAgent, defineTool];
export type Event = AgentEvent;
