import json, pathlib, yaml
P=pathlib.Path(__file__).resolve().parents[1]; D={}
ref=lambda n:{'$ref':f'#/$defs/{n}'}
def obj(props,required=None): return {'type':'object','properties':props,'required':list(props) if required is None else required,'additionalProperties':False}
s={'type':'string'}; b={'type':'boolean'}; n={'type':'integer','minimum':0}; pos={'type':'integer','minimum':1}
u={'type':'string','format':'uuid'}; dt={'type':'string','format':'date-time'}
nullable=lambda x:{'anyOf':[x,{'type':'null'}]}
arr=lambda x:{'type':'array','items':x}
en=lambda *v:{'type':'string','enum':list(v)}
D['Error']=obj({'code':s,'message':s,'retryable':b,'details':{'type':'object','additionalProperties':True},'requestId':u},['code','message','retryable','requestId'])
D['Actor']=obj({'kind':en('human','agent','system'),'id':u,'displayName':s})
D['TextBlock']=obj({'type':{'const':'text'},'text':{'type':'string','minLength':1,'maxLength':65536}})
D['ArtifactBlock']=obj({'type':{'const':'artifact'},'artifactId':u,'caption':s},['type','artifactId'])
D['Block']={'oneOf':[ref('TextBlock'),ref('ArtifactBlock')]}
D['Budget']=obj({'maxNativeTurns':{'type':'integer','minimum':1,'maximum':1000},'maxDepth':{'type':'integer','minimum':1,'maximum':32},'maxAgentFanout':{'type':'integer','minimum':1,'maximum':10},'wallTimeSec':{'type':'integer','minimum':60},'softTokenLimit':nullable(pos)})
D['Workspace']=obj({'id':u,'name':s,'state':en('active','paused','archived'),'version':pos,'createdAt':dt})
D['CreateWorkspace']=obj({'name':{'type':'string','minLength':1,'maxLength':80}})
D['WorkspaceControl']=obj({'action':en('pause','resume'),'expectedVersion':pos})
D['Host']=obj({'id':u,'name':s,'platform':s,'architecture':s,'state':en('online','offline','degraded','revoked'),'lastSeenAt':nullable(dt),'bootId':nullable(u),'capabilities':arr(s)})
D['PairHost']=obj({'pairingCode':s,'hostName':s,'publicIdentity':s})
D['HostEnrollment']=obj({'hostId':u,'hostCredential':s,'websocketPath':s})
D['Project']=obj({'id':u,'workspaceId':u,'hostId':u,'name':s,'rootPath':s,'baseRef':s,'workspaceMode':en('directory','git-worktree'),'version':pos},['id','workspaceId','hostId','name','rootPath','baseRef','version'])
D['CreateProject']=obj({'hostId':u,'name':s,'rootPath':{'type':'string','minLength':1},'baseRef':s,'workspaceMode':en('directory','git-worktree'),'expectedVersion':pos},['hostId','name','rootPath'])
D['InitializeGit']=obj({'rootPath':{'type':'string','minLength':1}})
D['RuntimeConfig']=obj({'driver':en('codex-app-server','claude-code-sdk'),'executableProfile':s,'model':s,'effort':nullable(s),'permissionProfile':en('review','workspace','desktop','read-only','ask-for-approval','auto-approve','full-access'),'settingsProfile':s},['driver','executableProfile','model','permissionProfile','settingsProfile'])
D['Agent']=obj({'id':u,'workspaceId':u,'hostId':u,'projectId':u,'name':s,'role':s,'runtime':ref('RuntimeConfig'),'desiredState':en('running','paused','stopped'),'observedState':en('stopped','starting','idle','working','waiting_approval','recovering','degraded','unknown'),'capabilities':arr(s),'version':pos})
D['CreateAgent']=obj({'hostId':u,'projectId':u,'name':{'type':'string','minLength':1,'maxLength':80},'role':s,'runtime':ref('RuntimeConfig'),'capabilities':arr(s)},['hostId','projectId','name','role','runtime'])
D['AgentControl']=obj({'action':en('start','pause','resume','stop','reset_session'),'expectedVersion':pos,'reason':s},['action','expectedVersion'])
D['DeleteAgent']=obj({'expectedVersion':pos})
D['PatchAgent']=obj({'expectedVersion':pos,'name':s,'role':s,'runtime':ref('RuntimeConfig'),'capabilities':arr(s)},['expectedVersion'])
D['Session']=obj({'id':u,'agentId':u,'driver':s,'nativeSessionId':nullable(s),'launchId':nullable(u),'generation':pos,'state':en('opening','ready','busy','waiting_approval','recovering','closed','failed','unknown'),'workspacePath':s,'createdAt':dt,'channelId':nullable(u)})
D['Channel']=obj({'id':u,'workspaceId':u,'name':s,'topic':s,'version':pos,'archived':b,'projectId':nullable(u)})
D['CreateChannel']=obj({'name':{'type':'string','minLength':1,'maxLength':80},'topic':s,'agentIds':{'type':'array','items':u,'uniqueItems':True},'projectId':u},['name'])
D['Members']=obj({'agentIds':{'type':'array','items':u,'uniqueItems':True},'expectedVersion':pos})
D['Thread']=obj({'id':u,'channelId':u,'title':s,'state':en('open','paused','closed'),'createdAt':dt})
D['CreateThread']=obj({'title':{'type':'string','minLength':1,'maxLength':160}})
D['PostMessage']=obj({'threadId':nullable(u),'replyToMessageId':nullable(u),'blocks':{'type':'array','items':ref('Block'),'minItems':1,'maxItems':32},'recipientAgentIds':{'type':'array','items':u,'uniqueItems':True,'maxItems':10},'requestResponse':b,'kind':en('message','progress','question','answer','proposal'),'continuationEpisodeId':nullable(u),'clientMessageId':u},['blocks','recipientAgentIds','requestResponse','kind','clientMessageId'])
D['StartConversation']=obj({'projectId':u,'agentIds':{'type':'array','items':u,'uniqueItems':True},'message':ref('PostMessage')})
D['Message']=obj({'id':u,'workspaceId':u,'channelId':u,'threadId':nullable(u),'replyToMessageId':nullable(u),'actor':ref('Actor'),'blocks':arr(ref('Block')),'recipientAgentIds':arr(u),'requestResponse':b,'kind':en('message','progress','question','answer','proposal','system'),'episodeId':u,'runId':nullable(u),'seq':{'type':'string','pattern':'^[0-9]+$'},'createdAt':dt})
D['Episode']=obj({'id':u,'workspaceId':u,'rootMessageId':nullable(u),'state':en('open','paused_budget','paused_human','complete'),'budget':ref('Budget'),'nativeTurnsReserved':n,'version':pos,'createdAt':dt})
D['EpisodeControl']=obj({'action':en('pause','continue','close'),'expectedVersion':pos,'additionalTurns':{'type':'integer','minimum':0,'maximum':100}},['action','expectedVersion'])
D['Task']=obj({'id':u,'workspaceId':u,'channelId':u,'threadId':u,'sourceMessageId':nullable(u),'title':s,'description':s,'acceptanceCriteria':arr(s),'status':en('todo','in_progress','blocked','in_review','done','cancelled'),'assigneeAgentId':nullable(u),'reviewerAgentId':nullable(u),'leaseEpoch':n,'version':pos,'artifactIds':arr(u),'dependencyTaskIds':arr(u)})
D['CreateTask']=obj({'channelId':u,'threadId':u,'sourceMessageId':nullable(u),'title':s,'description':s,'acceptanceCriteria':{'type':'array','items':s,'minItems':1},'reviewerAgentId':nullable(u),'dependencyTaskIds':arr(u)},['channelId','threadId','title','description','acceptanceCriteria'])
D['ClaimTask']=obj({'agentId':u,'expectedVersion':pos})
D['TaskTransition']=obj({'status':en('todo','blocked','in_review','done','cancelled'),'expectedVersion':pos,'leaseEpoch':n,'reason':s,'artifactIds':arr(u)},['status','expectedVersion','leaseEpoch'])
D['Run']=obj({'id':u,'agentId':u,'sessionId':u,'episodeId':u,'taskId':nullable(u),'primaryMessageId':u,'nativeTurnId':nullable(s),'state':en('scheduled','dispatching','running','waiting_approval','draining','completed','failed','interrupted','unknown'),'nativeOutcome':nullable(en('completed','failed','interrupted')),'launchId':nullable(u),'startedAt':nullable(dt),'endedAt':nullable(dt),'errorCode':nullable(s),'contextDigest':s,'contextArtifactId':nullable(u),'finalMessageId':nullable(u)})
D['RunControl']=obj({'action':en('interrupt','steer','reconcile'),'text':s,'clientMessageId':u,'reason':s},['action','clientMessageId'])
D['Delivery']=obj({'id':u,'agentId':u,'messageId':u,'runId':nullable(u),'state':en('pending','reserved','sent','cancelled','unknown'),'evidence':arr(en('transport_written','native_ack','context_included','agent_ack')),'attempt':n,'errorCode':nullable(s)})
D['Approval']=obj({'id':u,'workspaceId':u,'agentId':u,'runId':u,'launchId':u,'source':en('codex','claude','computer-use'),'kind':en('permission','question','form','url'),'state':en('pending','approved','denied','cancelled','expired','resolved','unknown'),'title':s,'inputSchema':{'type':'object','additionalProperties':True},'display':{'type':'object','additionalProperties':True},'allowedActions':arr(s),'argumentHash':s,'version':pos,'expiresAt':nullable(dt)})
D['ResolveApproval']=obj({'argumentHash':{'type':'string','pattern':'^[a-f0-9]{64}$'},'action':en('approve','deny','cancel'),'content':{'type':'object','additionalProperties':True},'scope':en('once','session'),'expectedVersion':pos},['action','expectedVersion','argumentHash'])
D['Artifact']=obj({'id':u,'workspaceId':u,'kind':en('file','image','diff','test_report','log','context'),'filename':s,'mimeType':s,'sizeBytes':n,'sha256':{'type':'string','pattern':'^[a-f0-9]{64}$'},'creator':ref('Actor'),'createdAt':dt,'retentionClass':en('durable','screenshot','diagnostic')})
D['Desktop']=obj({'hostId':u,'provider':en('lcu','direct-mcp','mock','disabled'),'qualified':b,'state':en('unavailable','free','held','draining','quarantined'),'leaseEpoch':n,'ownerAgentId':nullable(u),'ownerRunId':nullable(u),'inFlightCalls':n,'diagnostic':nullable(s)})
D['DesktopControl']=obj({'action':en('stop','clear_quarantine'),'reason':s},['action','reason'])
D['Memory']=obj({'id':u,'workspaceId':u,'scope':en('workspace','agent','thread'),'ownerId':nullable(u),'title':s,'body':s,'sourceMessageIds':arr(u),'status':en('proposed','accepted','superseded'),'version':pos})
D['ProposeMemory']=obj({'scope':en('workspace','agent','thread'),'ownerId':nullable(u),'title':s,'body':s,'sourceMessageIds':{'type':'array','items':u,'minItems':1}})
D['MemoryDecision']=obj({'action':en('accept','supersede'),'expectedVersion':pos})
D['RuntimeInventory']=obj({'hostId':u,'entries':arr(obj({'driver':s,'executableProfile':s,'version':nullable(s),'available':b,'authenticated':nullable(b),'models':arr(s),'features':arr(s),'diagnostic':nullable(s)}))})
D['Operation']=obj({'id':u,'state':en('accepted','running','completed','failed','unknown'),'result':{'type':'object','additionalProperties':True},'error':nullable(ref('Error'))},['id','state'])
D['Event']=obj({'schemaVersion':{'const':1},'eventId':u,'seq':{'type':'string','pattern':'^[0-9]+$'},'workspaceId':u,'type':{'type':'string','minLength':1},'occurredAt':dt,'actor':ref('Actor'),'entityId':nullable(u),'payload':{'type':'object','additionalProperties':True}},['schemaVersion','eventId','seq','workspaceId','type','occurredAt','actor','payload'])
D['Snapshot']=obj({'retentionFrontier':{'type':'string','pattern':'^[0-9]+$'},'workspace':ref('Workspace'),'snapshotSeq':{'type':'string','pattern':'^[0-9]+$'},'agents':arr(ref('Agent')),'channels':arr(ref('Channel')),'hosts':arr(ref('Host')),'activeRuns':arr(ref('Run')),'approvals':arr(ref('Approval'))})
D['Login']=obj({'oneTimeToken':s})
D['LoginResult']=obj({'authenticated':b,'csrfToken':s})
D['Health']=obj({'status':en('ok','degraded'),'version':s})
D['RegisterArtifact']=obj({'runId':u,'localPath':s,'kind':en('file','image','diff','test_report','log','context'),'filename':s})
D['AckInbox']=obj({'deliveryIds':{'type':'array','items':u,'minItems':1},'contextDigest':s})
D['Metrics']=obj({'activeRuns':n,'pendingDeliveries':n,'unknownRuns':n,'pendingApprovals':n,'hostLagMs':nullable(n),'desktopQuarantines':n})
D['RuntimeTraceRecord']=obj({'id':u,'launchId':u,'producerSeq':pos,'agentId':u,'sessionId':u,'runId':nullable(u),'nativeTurnId':nullable(s),'kind':s,'lane':arr(s),'occurredAt':dt,'payload':{'type':'object','additionalProperties':True}})
for name in ['Workspace','Host','Project','Agent','Session','Channel','Thread','Message','Task','Run','Delivery','Artifact','Memory','RuntimeTraceRecord']:
 D[name+'List']=obj({'items':arr(ref(name)),'nextCursor':nullable(s)})
D['ApprovalList']=obj({'items':arr(ref('Approval')),'nextCursor':nullable(s)})
# Canonical public event vocabulary: payloads are validated by event type.
event_payloads = {
 'workspace.updated': ('workspace','Workspace'), 'host.updated': ('host','Host'),
 'agent.updated': ('agent','Agent'), 'session.updated': ('session','Session'),
 'channel.updated': ('channel','Channel'), 'thread.updated': ('thread','Thread'),
 'message.created': ('message','Message'), 'delivery.updated': ('delivery','Delivery'),
 'episode.updated': ('episode','Episode'), 'run.scheduled': ('run','Run'),
 'run.updated': ('run','Run'), 'run.trace': ('record','RuntimeTraceRecord'),
 'task.created': ('task','Task'), 'task.claimed': ('task','Task'), 'task.updated': ('task','Task'),
 'approval.updated': ('approval','Approval'), 'artifact.created': ('artifact','Artifact'),
 'memory.updated': ('memory','Memory'), 'desktop.updated': ('desktop','Desktop'),
 'operation.updated': ('operation','Operation'), 'diagnostic': ('error','Error')
}
D['Event']['properties']['type'] = en(*event_payloads)
D['Event']['allOf'] = [
 {'if':{'properties':{'type':{'const':ev}},'required':['type']},
  'then':{'properties':{'payload':obj({field:ref(typ)})}}}
 for ev,(field,typ) in event_payloads.items()
]
schema={'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'https://harbor.local/contracts/domain.schema.json','title':'Atrium Grove 1.0 domain contracts','$defs':D}
(P/'contracts/domain.schema.json').write_text(json.dumps(schema,ensure_ascii=False,indent=2))
# OpenAPI embeds copies of the schemas, with references rewritten for OpenAPI.
def oref(x):
 if isinstance(x,list):return [oref(v) for v in x]
 if isinstance(x,dict):return {k:(v.replace('#/$defs/','#/components/schemas/') if k=='$ref' else oref(v)) for k,v in x.items()}
 return x
api={'openapi':'3.1.0','info':{'title':'Atrium Grove Control Plane API','version':'1.0.0','description':'Normative v1 routes. All mutation requests except authentication require X-CSRF-Token and Idempotency-Key. Identity is derived from authentication, never request bodies. See PROTOCOLS.md.'},'servers':[{'url':'http://127.0.0.1:4310'}],'security':[{'ownerSession':[]}],'paths':{},'components':{'securitySchemes':{'ownerSession':{'type':'apiKey','in':'cookie','name':'harbor_session'},'hostBearer':{'type':'http','scheme':'bearer'}},'schemas':{k:oref(v) for k,v in D.items()}}}
R=lambda name:{'$ref':'#/components/schemas/'+name}
def route(method,path,op,res,body=None,status='200',desc='',security=None):
 import re
 pars=[{'name':p,'in':'path','required':True,'schema':u} for p in re.findall(r'{(.*?)}',path)]
 if res.endswith('List'):
  pars.extend([{'name':'cursor','in':'query','schema':s},{'name':'limit','in':'query','schema':{'type':'integer','minimum':1,'maximum':200,'default':50}}])
 if method in ['post','patch','put','delete'] and path!='/v1/auth/exchange':
  pars.extend([{'name':'Idempotency-Key','in':'header','required':True,'schema':s},{'name':'X-CSRF-Token','in':'header','required':True,'schema':s}])
 responses={status:{'description':'Success','content':{'application/json':{'schema':R(res)}}}}
 for c,txt in [('400','Invalid request'),('401','Unauthenticated'),('403','Unauthorized'),('404','Not found'),('409','Version, ownership, or idempotency conflict'),('422','Policy or state prevents operation'),('429','Budget or rate limit'),('503','Host/provider unavailable')]:
  responses[c]={'description':txt,'content':{'application/json':{'schema':R('Error')}}}
 item={'operationId':op,'description':desc or op,'responses':responses}
 if pars:item['parameters']=pars
 if body:item['requestBody']={'required':True,'content':{'application/json':{'schema':R(body)}}}
 if security is not None:item['security']=security
 api['paths'].setdefault(path,{})[method]=item
route('get','/v1/health','health','Health',security=[])
route('post','/v1/auth/exchange','exchangeLogin','LoginResult','Login',security=[])
route('post','/v1/auth/logout','logout','LoginResult')
route('get','/v1/workspaces','listWorkspaces','WorkspaceList')
route('post','/v1/workspaces','createWorkspace','Workspace','CreateWorkspace','201')
route('get','/v1/workspaces/{workspaceId}/snapshot','workspaceSnapshot','Snapshot')
route('post','/v1/workspaces/{workspaceId}/control','workspaceControl','Workspace','WorkspaceControl')
route('get','/v1/hosts','listHosts','HostList')
route('get','/v1/hosts/{hostId}/inventory','hostInventory','RuntimeInventory')
route('post','/v1/hosts/{hostId}/probe','probeHost','Operation',status='202')
route('post','/v1/hosts/{hostId}/git','initializeGit','Operation','InitializeGit','202')
route('get','/v1/workspaces/{workspaceId}/projects','listProjects','ProjectList')
route('post','/v1/workspaces/{workspaceId}/projects','createProject','Project','CreateProject','201')
route('get','/v1/workspaces/{workspaceId}/agents','listAgents','AgentList')
route('post','/v1/workspaces/{workspaceId}/agents','createAgent','Agent','CreateAgent','201')
route('get','/v1/agents/{agentId}','getAgent','Agent')
route('patch','/v1/agents/{agentId}','patchAgent','Agent','PatchAgent')
route('delete','/v1/agents/{agentId}','deleteAgent','Agent','DeleteAgent')
route('post','/v1/agents/{agentId}/control','controlAgent','Operation','AgentControl','202')
route('get','/v1/agents/{agentId}/sessions','listAgentSessions','SessionList')
route('get','/v1/agents/{agentId}/deliveries','listAgentDeliveries','DeliveryList')
route('get','/v1/workspaces/{workspaceId}/channels','listChannels','ChannelList')
route('post','/v1/workspaces/{workspaceId}/channels','createChannel','Channel','CreateChannel','201')
route('put','/v1/channels/{channelId}/members','setChannelMembers','Channel','Members')
route('get','/v1/channels/{channelId}/threads','listThreads','ThreadList')
route('post','/v1/channels/{channelId}/threads','createThread','Thread','CreateThread','201')
route('get','/v1/channels/{channelId}/messages','listMessages','MessageList',desc='Chronological page. Optional threadId is a UUID query filter; snapshots are immutable.')
api['paths']['/v1/channels/{channelId}/messages']['get']['parameters'].append({'name':'threadId','in':'query','schema':u})
route('post','/v1/channels/{channelId}/messages','postMessage','Message','PostMessage','201')
route('get','/v1/episodes/{episodeId}','getEpisode','Episode')
route('post','/v1/episodes/{episodeId}/control','controlEpisode','Episode','EpisodeControl')
route('get','/v1/workspaces/{workspaceId}/tasks','listTasks','TaskList')
route('post','/v1/workspaces/{workspaceId}/tasks','createTask','Task','CreateTask','201')
route('get','/v1/tasks/{taskId}','getTask','Task')
route('post','/v1/tasks/{taskId}/claim','claimTask','Task','ClaimTask')
route('post','/v1/tasks/{taskId}/transition','transitionTask','Task','TaskTransition')
route('post','/v1/workspaces/{workspaceId}/conversations','startConversation','Message','StartConversation')
route('get','/v1/workspaces/{workspaceId}/runs','listRuns','RunList')
api['paths']['/v1/workspaces/{workspaceId}/runs']['get']['parameters'].append({'name':'channelId','in':'query','schema':u})
route('get','/v1/runs/{runId}','getRun','Run')
route('get','/v1/runs/{runId}/events','getRunEvents','RuntimeTraceRecordList')
route('post','/v1/runs/{runId}/control','controlRun','Operation','RunControl','202')
route('get','/v1/workspaces/{workspaceId}/approvals','listApprovals','ApprovalList')
route('post','/v1/approvals/{approvalId}/resolve','resolveApproval','Approval','ResolveApproval')
route('get','/v1/workspaces/{workspaceId}/artifacts','listArtifacts','ArtifactList')
route('get','/v1/artifacts/{artifactId}','artifactMetadata','Artifact')
route('get','/v1/artifacts/{artifactId}/content','artifactContent','Artifact',desc='Binary response. Enforce workspace visibility; Content-Disposition attachment except safe image previews; nosniff.')
api['paths']['/v1/artifacts/{artifactId}/content']['get']['responses']['200']['content']={'application/octet-stream':{'schema':{'type':'string','format':'binary'}}}
route('get','/v1/workspaces/{workspaceId}/memory','listMemory','MemoryList')
route('post','/v1/workspaces/{workspaceId}/memory','proposeMemory','Memory','ProposeMemory','201')
route('post','/v1/memory/{memoryId}/decision','decideMemory','Memory','MemoryDecision')
route('get','/v1/hosts/{hostId}/desktop','desktopStatus','Desktop')
route('post','/v1/hosts/{hostId}/desktop/control','desktopControl','Operation','DesktopControl','202')
route('get','/v1/operations/{operationId}','getOperation','Operation')
route('get','/v1/workspaces/{workspaceId}/metrics','metrics','Metrics')
route('get','/v1/workspaces/{workspaceId}/events','events','Event',desc='SSE: id=decimal seq; data=Event. Resume after or Last-Event-ID. Return 410 if replay window pruned. Heartbeats do not advance cursor.')
e=api['paths']['/v1/workspaces/{workspaceId}/events']['get'];e['responses']['200']['content']={'text/event-stream':{'schema':s}};e['responses']['410']={'description':'Replay window expired; reload snapshot','content':{'application/json':{'schema':R('Error')}}};e['parameters'] += [{'name':'after','in':'query','schema':{'type':'string','pattern':'^[0-9]+$'}},{'name':'Last-Event-ID','in':'header','schema':s}]
# Upload has binary payload and metadata headers to avoid multipart-library assumptions.
route('post','/v1/workspaces/{workspaceId}/artifacts','uploadArtifact','Artifact',status='201',desc='Owner upload, max 25 MiB. X-Filename is UTF-8 percent-encoded. Validate signature/MIME; no arbitrary server path.')
upload=api['paths']['/v1/workspaces/{workspaceId}/artifacts']['post'];upload['parameters'] += [{'name':'X-Filename','in':'header','required':True,'schema':s}];upload['requestBody']={'required':True,'content':{'application/octet-stream':{'schema':{'type':'string','format':'binary'}}}}
(P/'contracts/openapi.yaml').write_text(yaml.safe_dump(api,allow_unicode=True,sort_keys=False))
print('Definitions:',len(D),'HTTP operations:',sum(len(v) for v in api['paths'].values()))
