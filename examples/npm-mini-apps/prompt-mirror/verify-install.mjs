import { AIHandler, envKeySource } from '@jxburros/ai-nugget';
if (typeof AIHandler !== 'function' || typeof envKeySource !== 'function') throw new Error('AI Nugget npm import failed');
console.log('AI Nugget npm import OK');
