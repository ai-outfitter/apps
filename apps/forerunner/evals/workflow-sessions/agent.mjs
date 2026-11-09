import {getAgent,registerAgent} from '@vercel/agent-eval';

/** Public custom-agent adapter. Production workflow code runs in setup; the CLI only reviews its fixed outputs. */
export function registerWorkflowReplay(judge) {
  if (!judge?.agent || !judge.model) throw new Error('Pin judge.agent and judge.model');
  const reviewer=getAgent(judge.agent);
  const definition={...reviewer.definition,name:'workflow-replay',displayName:'Recorded workflow replay',defaultModel:'captured'};
  const agent={name:definition.name,displayName:definition.displayName,definition,
    getApiKeyEnvVar:()=>reviewer.getApiKeyEnvVar(),getDefaultModel:()=>definition.defaultModel,
    async run(fixture,options) {
      const started=Date.now(); let candidate;
      const review=await reviewer.run(fixture,{...options,model:judge.model,judge,
        protectedPaths:[...(options.protectedPaths??[]),"session.json","candidate.json","replay.mjs","replay-config.json"],
        apiKey:process.env[reviewer.getApiKeyEnvVar()] ?? options.apiKey,
        prompt:'Review the already generated candidate.json against session.json. Do not change any files or rerun inference. The evaluation tests will grade the fixed candidate. Report only your assessment.',
        setup:async sandbox=>{
          await options.setup?.(sandbox);
          const installed=await sandbox.runCommand('npm',['install','--ignore-scripts']);
          if(installed.exitCode)throw new Error(`Replay dependencies failed: ${installed.stderr.slice(-1500)}`);
          const result=await sandbox.runCommand('node',['replay.mjs'],{env:Object.fromEntries(['WORKFLOW_EVAL_API_KEY','WORKFLOW_EVAL_BASE_URL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))});
          if(result.exitCode)throw new Error(`Workflow replay failed: ${result.stderr.slice(-1500)}`);
          candidate=JSON.parse(await sandbox.readFile('candidate.json'));
        },
      });
      if(!candidate)return {...review,error:review.error??'Workflow replay did not produce a candidate'};
      const usage=inferenceUsage(candidate.session);
      return {...review,duration:Date.now()-started,observedModel:candidate.session.entries.find(e=>e.kind==='inference-start')?.data.model,
        usage:Object.keys(usage).length ? usage : undefined,
        transcript:candidate.session.entries.map(e=>JSON.stringify(e)).join('\n'),
        generatedFiles:{...review.generatedFiles,'candidate.json':Buffer.from(JSON.stringify(candidate,null,2)),
          'judge-transcript.jsonl':Buffer.from(review.transcript??''),'judge-usage.json':Buffer.from(JSON.stringify(review.usage??null))}};
    }};
  registerAgent(agent);return agent;
}

/** Agent Eval accepts custom execution adapters but its Playground parsers are built-in.
 * Supply its public Transcript shape after save, preserving native session JSONL separately. */
export const workflowTranscriptReporter={name:'workflow-transcript',async onExperimentComplete(event){
  const {readFile,writeFile,readdir}=await import('node:fs/promises');
  const {join}=await import('node:path');
  for(const evalName of await readdir(event.outputDir)){
    let runs;try{runs=await readdir(join(event.outputDir,evalName));}catch{continue;}
    for(const run of runs.filter(r=>r.startsWith('run-'))){
      const dir=join(event.outputDir,evalName,run);let entries;
      try{entries=(await readFile(join(dir,'transcript-raw.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));}catch{continue;}
      const events=entries.map(e=>({timestamp:e.at,type:e.data?.error?'error':'message',role:e.kind==='inference-start'?'user':'assistant',content:JSON.stringify(e.data,null,2)}));
      const result=JSON.parse(await readFile(join(dir,'result.json'),'utf8'));
      const summary={totalTurns:events.filter(e=>e.role==='assistant').length,totalToolCalls:0,toolCalls:Object.fromEntries(["file_read","file_write","file_edit","shell","web_fetch","web_search","glob","grep","list_dir","agent_task","unknown"].map(k=>[k,0])),webFetches:[],filesRead:[],filesModified:[],shellCommands:[],errors:events.filter(e=>e.type==='error').map(e=>e.content),thinkingBlocks:0,...(result.usage?{usage:result.usage}:{})};
      await writeFile(join(dir,'transcript.json'),JSON.stringify({agent:'workflow-replay',model:result.model,events,summary,parseSuccess:true,parseErrors:[]},null,2));
      await writeFile(join(dir,'result.json'),JSON.stringify({...result,o11y:summary},null,2));
    }
  }
}};

function inferenceUsage(session){
  const usage={};
  for(const entry of session.entries.filter(e=>e.kind==='inference-result')){
    for(const key of ['inputTokens','outputTokens','totalTokens']){
      const value=entry.data.usage?.[key];if(typeof value==='number')usage[key]=(usage[key]??0)+value;
    }
  }
  return usage;
}
