import { ContextEngine } from '@jxburros/context-nugget';
import { asAiNuggetContextMessages, asAiNuggetMetadata } from '@jxburros/context-nugget/ai-nugget';

const engine = new ContextEngine();

await engine.addMemory({
  id: 'style-minimal',
  layer: 'user',
  scope: 'user:demo',
  text: 'The user prefers concise, direct answers with citations when context is provided.',
  importance: 0.7,
  confidence: 1,
  createdAt: new Date().toISOString(),
});

const latestUserMessage = 'How should you answer when using retrieved context?';

const context = await engine.retrieveAndPack({
  query: latestUserMessage,
  layers: ['user'],
  scope: 'user:demo',
  budget: { maxTokens: 1000 },
  pack: { includeCitations: true },
});

const messages = [
  { role: 'system', content: 'Use provided context when relevant. Do not invent sources.' },
  ...asAiNuggetContextMessages(context),
  { role: 'user', content: latestUserMessage },
];

const metadata = asAiNuggetMetadata(context);

console.log({ messages, metadata });
