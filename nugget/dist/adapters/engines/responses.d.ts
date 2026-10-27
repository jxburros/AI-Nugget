import type { ChatRequest, ResolvedConnection, StreamEvent } from '../../types.js';
import { OpenAIChatAdapter } from './openaiChat.js';
import type { ProviderProfile } from '../profiles.js';
/** Responses wire format shared by compatible providers. Explicit opt-in only. */
export declare class ResponsesAdapter extends OpenAIChatAdapter {
    private responsesProfile;
    constructor(provider: string, responsesProfile: ProviderProfile);
    stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent>;
}
//# sourceMappingURL=responses.d.ts.map