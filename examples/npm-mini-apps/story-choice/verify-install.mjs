import { AIHandler, envKeySource, extractJsonWithSchema } from '@jxburros/ai-nugget';
if (typeof AIHandler !== 'function' || typeof envKeySource !== 'function' || typeof extractJsonWithSchema !== 'function') {
  throw new Error('AI Nugget npm import failed');
}
console.log('AI Nugget npm import OK');
