from pathlib import Path
import json,uuid,hashlib
P=Path(__file__).resolve().parents[1]
u={'type':'string','format':'uuid'};s={'type':'string'};b={'type':'boolean'};pos={'type':'integer','minimum':1};a=lambda t:{'type':'array','items':t};en=lambda *v:{'type':'string','enum':list(v)}
def obj(p,r=None):return {'type':'object','properties':p,'required':list(p) if r is None else r,'additionalProperties':False}
key={'type':'string','minLength':1,'maxLength':160}
tools={
 'collab_context':obj({}),
 'collab_read':obj({'channelId':u,'threadId':u,'afterSeq':{'type':'string','pattern':'^[0-9]+$'},'limit':{'type':'integer','minimum':1,'maximum':50}},['channelId']),
 'collab_post':obj({'artifactIds':a(u),'channelId':u,'threadId':u,'replyToMessageId':u,'text':{'type':'string','minLength':1,'maxLength':65536},'recipients':{'type':'array','items':u,'uniqueItems':True,'maxItems':3},'requestResponse':b,'kind':en('message','progress','question','answer','proposal'),'requestKey':key},['channelId','text','recipients','requestResponse','kind','requestKey']),
 'collab_inbox':obj({'limit':{'type':'integer','minimum':1,'maximum':50}},[]),
 'collab_ack':obj({'deliveryIds':{'type':'array','items':u,'minItems':1,'maxItems':50,'uniqueItems':True},'readReceiptId':u,'requestKey':key},['deliveryIds','requestKey']),
 'task_list':obj({'channelId':u,'status':en('todo','in_progress','blocked','in_review','done','cancelled'),'cursor':s,'limit':{'type':'integer','minimum':1,'maximum':50}},[]),
 'task_get':obj({'taskId':u}),
 'task_create':obj({'reviewerAgentId':u,'channelId':u,'threadId':u,'sourceMessageId':u,'title':{'type':'string','minLength':1,'maxLength':160},'description':s,'acceptanceCriteria':{'type':'array','items':s,'minItems':1},'dependencies':{'type':'array','items':u,'uniqueItems':True},'requestKey':key},['channelId','threadId','title','description','acceptanceCriteria','requestKey']),
 'task_claim':obj({'taskId':u,'expectedVersion':pos,'requestKey':key}),
 'task_transition':obj({'taskId':u,'status':en('todo','blocked','in_review','done','cancelled'),'expectedVersion':pos,'leaseEpoch':{'type':'integer','minimum':0},'reason':s,'artifactIds':a(u),'requestKey':key},['taskId','status','expectedVersion','leaseEpoch','artifactIds','requestKey']),
 'artifact_register':obj({'localPath':s,'kind':en('file','image','diff','test_report','log'),'filename':s,'requestKey':key}),
 'artifact_read':obj({'artifactId':u}),
 'memory_propose':obj({'scope':en('workspace','agent','thread'),'ownerId':u,'title':s,'body':s,'sourceMessageIds':{'type':'array','items':u,'minItems':1},'requestKey':key},['scope','title','body','sourceMessageIds','requestKey'])
}
(P/'contracts/tools.schema.json').write_text(json.dumps({'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'https://harbor.local/contracts/tools.schema.json','title':'Atrium Grove model-facing tool arguments','$defs':tools},ensure_ascii=False,indent=2))
# Stable UUID fixtures only; not credentials or real sessions.
id=lambda n:str(uuid.UUID(int=n))
actor={'kind':'human','id':id(1),'displayName':'Owner'}
now='2026-10-09T06:00:00Z'
post={'blocks':[{'type':'text','text':'请共同评审CSV导入方案；先讨论，再领取具体任务。'}],'recipientAgentIds':[id(20),id(21),id(22),id(23),id(24)],'requestResponse':True,'kind':'message','clientMessageId':id(60)}
message={'id':id(61),'workspaceId':id(2),'channelId':id(10),'threadId':None,'replyToMessageId':None,'actor':actor,'blocks':post['blocks'],'recipientAgentIds':post['recipientAgentIds'],'requestResponse':True,'kind':'message','episodeId':id(50),'runId':None,'seq':'12','createdAt':now}
episode={'id':id(50),'workspaceId':id(2),'rootMessageId':id(61),'state':'open','budget':{'maxNativeTurns':32,'maxDepth':8,'maxAgentFanout':3,'wallTimeSec':3600,'softTokenLimit':None},'nativeTurnsReserved':0,'version':1,'createdAt':now}
event={'schemaVersion':1,'eventId':id(62),'seq':'12','workspaceId':id(2),'type':'message.created','occurredAt':now,'actor':actor,'entityId':id(61),'payload':{'message':message}}
fixtures=[{'schema':'PostMessage','data':post},{'schema':'Message','data':message},{'schema':'Episode','data':episode},{'schema':'Event','data':event}]
(P/'examples/domain-fixtures.json').write_text(json.dumps(fixtures,ensure_ascii=False,indent=2))
(P/'examples/events.jsonl').write_text(json.dumps(event,ensure_ascii=False)+'\n')
toolcase={'tool':'collab_post','arguments':{'channelId':id(10),'threadId':id(11),'replyToMessageId':id(61),'text':'建议先验证缺失值处理。请Reviewer检查以下假设。','recipients':[id(24)],'requestResponse':True,'kind':'question','requestKey':id(70)}}
(P/'examples/tool-fixtures.json').write_text(json.dumps([toolcase],ensure_ascii=False,indent=2))
