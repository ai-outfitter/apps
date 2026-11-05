import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('./preview.css',import.meta.url));
const source=JSON.parse(readFileSync(new URL('./app.json',import.meta.url),'utf8'));
const artifact={mainModule:'entry.mjs',compatibilityDate:'2026-09-29',compatibilityFlags:[],modules:{'entry.mjs':`const html=${JSON.stringify(html)};export default {async fetch(request,env){const url=new URL(request.url);return url.pathname==='/'?new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}}):env.ASSETS.fetch(request)}};`},assets:{'/preview.css':{content:css.toString('base64'),contentType:'text/css'}}};
mkdirSync('dist',{recursive:true});writeFileSync('dist/preview.json',JSON.stringify({manifest:{id:source.id,version:source.version,mode:'demo',capabilities:[]},artifact}));
