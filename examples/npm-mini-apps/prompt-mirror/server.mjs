import express from 'express';
import { AIHandler, envKeySource } from '@jxburros/ai-nugget';
const app=express(),port=process.env.PORT||3031,handler=new AIHandler({keySource:envKeySource()});
const conn={id:'app',provider:process.env.AI_PROVIDER||'openai',keyRef:{kind:'env',name:process.env.AI_KEY_ENV||'OPENAI_API_KEY'}};
app.use(express.json());app.use(express.static(new URL('./public',import.meta.url).pathname));
app.post('/api/reflect',async(req,res)=>{try{const note=String(req.body.note||'').slice(0,2000);const out=await handler.chat(conn,{model:process.env.AI_MODEL||'gpt-4o-mini',messages:[{role:'system',content:'Return ONLY JSON with reflection,reframe,tinyStep,question. Be warm and practical.'},{role:'user',content:note}]});res.json(JSON.parse(out.text.match(/\{[\s\S]*\}/)[0]))}catch(e){res.status(500).json({error:e.message})}});app.listen(port,()=>console.log(`http://localhost:${port}`));
