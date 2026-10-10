#!/usr/bin/env node
// Deterministic subprocess oracle, never used as evidence of native compatibility.
import {createInterface} from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let thread='fake-thread',turn=null,threadParams=null;
for await(const line of createInterface({input:process.stdin})){
  const m=JSON.parse(line),p=m.params??{};
  if(m.method==='initialize')send({id:m.id,result:{userAgent:'harbor-fake'}});
  if(m.method==='thread/start'||m.method==='thread/resume'){threadParams=p;thread=p.threadId??thread;send({id:m.id,result:{thread:{id:thread},model:'fake-model'}});}
  if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{unmanaged_computer:{enabled:true}}}}});
  if(m.method==='test/permissions')send({id:m.id,result:threadParams});
  if(m.method==='turn/start'){
    turn='fake-turn';send({id:m.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn}}});
    send({method:'item/started',params:{item:{id:'call-a',type:'commandExecution',command:'printf streamed',cwd:'/tmp'}}});
    send({method:'item/commandExecution/outputDelta',params:{itemId:'call-a',delta:'streamed'}});
    send({method:'item/agentMessage/delta',params:{itemId:'message-a',delta:'A1'}});
    send({method:'item/agentMessage/delta',params:{itemId:'message-b',delta:'B1'}});
    send({method:'item/agentMessage/delta',params:{itemId:'message-a',delta:'A2'}});
    send({method:'future/native-event',params:{diagnostic:'keep this unknown payload'}});
  }
  if(m.method==='test/release'){
    send({id:m.id,result:{}});send({method:'item/completed',params:{item:{id:'call-a',type:'commandExecution',status:'completed',aggregatedOutput:'streamed',exitCode:0}}});
    send({method:'item/completed',params:{item:{id:'message-a',type:'agentMessage',phase:'final_answer',text:'A1A2'}}});
    send({method:'turn/completed',params:{turn:{id:turn,status:'completed'}}});turn=null;
  }
  if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{turn:{id:turn,status:'interrupted'}}});turn=null;}
}
