#!/usr/bin/env node
// tsx loads the SDK's TypeScript source in Node without a private platform loader.
import {register} from 'tsx/esm/api';
register();
import {parseArgs} from 'node:util';
const {values,positionals}=parseArgs({allowPositionals:true,options:{mode:{type:'string'},output:{type:'string'}}});
if(positionals.length>1) throw Error('Usage: outfitter-app-build [directory] [--mode demo|operational] [--output path]');
const {buildApp}=await import('./build.mjs');
await buildApp(positionals[0] || '.',values);
